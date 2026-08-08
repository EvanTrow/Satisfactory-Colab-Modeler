import crypto from "node:crypto";

import { defaultGameData, findVariant, resolveMachine, type ResolvedMultiMachine } from "@scm/gamedata";
import { parseRational, toApproximateNumber } from "@scm/rational";
import { addEdge, addNode, createDocument, removeEdge, removeNode } from "@scm/ydoc";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { appendUpdate } from "./docStorage.js";
import { closeDb, db } from "./db.js";
import { deriveApprox } from "./projection.js";

// Real Postgres, same precedent as docStorage.test.ts.

afterAll(async () => {
  await closeDb();
});

async function createTestUser(username: string) {
  return db
    .insertInto("users")
    .values({ discord_id: `test-${crypto.randomUUID()}`, username })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function createTestProject(ownerId: string) {
  return db
    .insertInto("projects")
    .values({ short_id: crypto.randomUUID(), owner_id: ownerId, game_data_version: "test" })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Wraps a fresh `SfmDocument` and tracks the incremental Yjs update since
 * the last call to `diff()` — the same pattern `docStorage.test.ts`'s
 * `createMarkerEditor` uses, generalized to the whole document rather than
 * just `meta.marker`. Each `diff()` result is exactly what a real client's
 * `doc.on('update', ...)` listener would produce for the edits made since
 * the previous `diff()` call, so feeding successive results through
 * `appendUpdate` exercises the real incremental-update path (not a
 * from-scratch full-state replace each time).
 */
function createDocEditor() {
  const doc = new Y.Doc();
  // Captured on a genuinely empty `Y.Doc` — BEFORE `createDocument` below
  // runs its own `doc.transact()` calls to populate default `meta`/
  // `settings` — so the first `diff()` includes those defaults too. A state
  // vector captured *after* those defaults would make the first `diff()` a
  // partial update whose starting clock is > 0 for this client; a receiver
  // that never saw the (never-sent) clock-0..N defaults has a causal gap it
  // can't integrate, and Yjs silently buffers/drops that struct instead of
  // throwing — this is exactly the trap this comment exists to name, not a
  // Yjs bug: `encodeStateAsUpdate(doc, vector)` is a genuine *diff*, only
  // valid to apply on top of the exact baseline `vector` describes.
  let priorVector = Y.encodeStateVector(doc);
  const sfmDoc = createDocument({ doc });
  return {
    sfmDoc,
    diff(): Uint8Array {
      const update = Y.encodeStateAsUpdate(doc, priorVector);
      priorVector = Y.encodeStateVector(doc);
      return update;
    },
  };
}

async function fetchProjNodes(projectId: string) {
  return db.selectFrom("proj_nodes").selectAll().where("project_id", "=", projectId).execute();
}

async function fetchProjEdges(projectId: string) {
  return db.selectFrom("proj_edges").selectAll().where("project_id", "=", projectId).execute();
}

describe("deriveApprox", () => {
  it("returns null for a null exact value", () => {
    expect(deriveApprox(null)).toBeNull();
  });

  it("derives a double precision approximation FROM the exact string, via @scm/rational's own float boundary", () => {
    // 1/3 has no exact double representation — this is exactly the case the
    // "approx column, sorting/filtering only" rule exists for.
    expect(deriveApprox("1/3")).toBeCloseTo(1 / 3, 15);
    expect(deriveApprox("7/3")).toBeCloseTo(7 / 3, 15);
    expect(deriveApprox("150")).toBe(150);
    expect(deriveApprox("-9/5")).toBeCloseTo(-1.8, 15);
  });

  it("never throws on malformed input — defensive against corrupt/foreign data, logs and returns null", () => {
    expect(deriveApprox("not a rational")).toBeNull();
  });
});

describe("materializeProjection (hooked into appendUpdate, Job 025)", () => {
  it("materializes a small factory's nodes and edges into proj_nodes/proj_edges", async () => {
    const owner = await createTestUser("projection-basic-owner");
    const project = await createTestProject(owner.id);

    const editor = createDocEditor();
    const smelter = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Iron Ingot",
      machine: "Smelter",
      x: 10,
      y: 20,
      title: "Iron Ingot",
      color: "#123456",
      limit: "5",
      limitMode: "machines",
      clock: "100",
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    const constructor_ = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Iron Plate",
      machine: "Constructor",
      x: 40,
      y: 20,
      title: "Iron Plate",
      color: "#123456",
      limit: "2",
      limitMode: "machines",
      clock: "100",
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    const edge = addEdge(editor.sfmDoc, {
      containerId: "c_root",
      part: "Iron Ingot",
      fromNode: smelter.id,
      fromPort: "out",
      toNode: constructor_.id,
      toPort: "in",
      style: null,
      labelPos: null,
    });

    await appendUpdate(project.id, editor.diff(), owner.id);

    const nodeRows = await fetchProjNodes(project.id);
    expect(nodeRows).toHaveLength(2);
    const smelterRow = nodeRows.find((r) => r.node_id === smelter.id);
    expect(smelterRow).toMatchObject({
      project_id: project.id,
      container_id: "c_root",
      kind: "recipe",
      recipe_name: "Iron Ingot",
      machine_name: "Smelter",
      pos_x: 10,
      pos_y: 20,
      limit_exact: "5",
      clock_exact: "100",
      shards: 0,
      purity: null,
      belt_tier: null,
      storage_mode: null,
    });
    expect(smelterRow!.limit_approx).toBe(5);
    expect(smelterRow!.clock_approx).toBe(100);

    const edgeRows = await fetchProjEdges(project.id);
    expect(edgeRows).toHaveLength(1);
    expect(edgeRows[0]).toMatchObject({
      project_id: project.id,
      edge_id: edge.id,
      part: "Iron Ingot",
      from_node: smelter.id,
      from_port: "out",
      to_node: constructor_.id,
      to_port: "in",
    });
    // `waypoints` is stored as real `jsonb` (see `toProjEdgeRow`'s doc
    // comment on the explicit `::jsonb` cast), but the
    // Kysely/kysely-postgres-js/postgres.js pipeline this app uses reads it
    // back as the raw JSON *text*, not an auto-parsed value —
    // `PostgresJSConnection.executeQuery` drives `postgres.js` via
    // `.unsafe(sql, params)`, and (verified empirically against a real
    // table/column, not just this app's code) that specific call shape does
    // not apply postgres.js's usual oid-based column parsers the way a
    // tagged-template query does. Callers of `proj_edges.waypoints` must
    // `JSON.parse` it themselves — see this job's Handoff notes.
    expect(JSON.parse(edgeRows[0]!.waypoints as string)).toEqual([]);
  });

  it("resolves a MultiMachine node's machine_name/purity/limit_exact correctly (Miner Mk.2 on Pure)", async () => {
    const owner = await createTestUser("projection-multimachine-owner");
    const project = await createTestProject(owner.id);

    // Mirrors exactly what the real Recipe Chooser does
    // (apps/web/src/panels/recipeChooser/filters.ts's
    // `buildNodeInputForRecipe`): resolve the recipe's raw `machine` field
    // ("Miner") against @scm/gamedata's MultiMachine table, pick the
    // Mk.2/Pure variant, and store the *resolved concrete* machine name
    // ("Miner Mk.2") on the node — never the family name. This proves the
    // acceptance criterion end to end against the real game data, not a
    // hand-typed stand-in string.
    const minerRecipe = defaultGameData.recipesByMachine.get("Miner")![0]!;
    const resolved = resolveMachine(minerRecipe.machine, defaultGameData) as ResolvedMultiMachine;
    expect(resolved.kind).toBe("multiMachine");
    const variant = findVariant(resolved, { model: "Miner Mk.2", capacity: "Pure" });
    expect(variant).toBeDefined();
    expect(variant!.machine.name).toBe("Miner Mk.2");

    const editor = createDocEditor();
    const miner = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: minerRecipe.name,
      machine: variant!.machine.name,
      x: 0,
      y: 0,
      title: minerRecipe.name,
      color: "#123456",
      limit: "7/3",
      limitMode: "ppm",
      clock: "150",
      autoRound: false,
      shards: 0,
      purity: "pure",
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });

    await appendUpdate(project.id, editor.diff(), owner.id);

    const rows = await fetchProjNodes(project.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.node_id).toBe(miner.id);
    expect(row.machine_name).toBe("Miner Mk.2");
    expect(row.purity).toBe("pure");
    expect(row.limit_exact).toBe("7/3");
    // limit_approx must be DERIVED from limit_exact (@scm/rational's own
    // parseRational + toApproximateNumber), never independently computed —
    // asserted here by recomputing the same way and comparing exactly, not
    // just "close enough".
    expect(row.limit_approx).toBe(toApproximateNumber(parseRational("7/3")));
  });

  it("limit_exact/clock_exact round-trip through @scm/rational's parser back to the original value", async () => {
    const owner = await createTestUser("projection-roundtrip-owner");
    const project = await createTestProject(owner.id);

    const editor = createDocEditor();
    const node = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Screw",
      machine: "Constructor",
      x: 0,
      y: 0,
      title: "Screw",
      color: "#123456",
      limit: "-9/5",
      limitMode: "machines",
      clock: "1321929/1000000",
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    await appendUpdate(project.id, editor.diff(), owner.id);

    const [row] = await fetchProjNodes(project.id);
    expect(row!.node_id).toBe(node.id);

    // Round-trip: parsing the stored exact string back gives exactly the
    // same Rational as parsing the original — lossless, per PLAN.md's
    // "Rational storage" callout.
    const originalLimit = parseRational("-9/5");
    const storedLimit = parseRational(row!.limit_exact!);
    expect(storedLimit).toEqual(originalLimit);

    const originalClock = parseRational("1321929/1000000");
    const storedClock = parseRational(row!.clock_exact!);
    expect(storedClock).toEqual(originalClock);

    // limit_approx/clock_approx are consistent with (never contradict)
    // their _exact counterparts — recomputing from _exact and comparing
    // exactly (both routes go through the identical parseRational +
    // toApproximateNumber pipeline, so there is no float-precision slop to
    // tolerate here).
    expect(row!.limit_approx).toBe(toApproximateNumber(originalLimit));
    expect(row!.clock_approx).toBe(toApproximateNumber(originalClock));
  });

  it("removes a node's row from proj_nodes once it's deleted from the live doc — no stale rows", async () => {
    const owner = await createTestUser("projection-node-delete-owner");
    const project = await createTestProject(owner.id);

    const editor = createDocEditor();
    const node = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Iron Ingot",
      machine: "Smelter",
      x: 0,
      y: 0,
      title: "Iron Ingot",
      color: "#123456",
      limit: "1",
      limitMode: "machines",
      clock: "100",
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    await appendUpdate(project.id, editor.diff(), owner.id);
    expect(await fetchProjNodes(project.id)).toHaveLength(1);

    removeNode(editor.sfmDoc, node.id);
    await appendUpdate(project.id, editor.diff(), owner.id);

    const rowsAfterDelete = await fetchProjNodes(project.id);
    expect(rowsAfterDelete).toHaveLength(0);
  });

  it("removes an edge's row from proj_edges once it's deleted from the live doc — no stale rows", async () => {
    const owner = await createTestUser("projection-edge-delete-owner");
    const project = await createTestProject(owner.id);

    const editor = createDocEditor();
    const a = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Iron Ingot",
      machine: "Smelter",
      x: 0,
      y: 0,
      title: "A",
      color: "#123456",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    const b = addNode(editor.sfmDoc, {
      containerId: "c_root",
      kind: "recipe",
      recipe: "Iron Plate",
      machine: "Constructor",
      x: 40,
      y: 0,
      title: "B",
      color: "#123456",
      limit: null,
      limitMode: "machines",
      clock: null,
      autoRound: false,
      shards: 0,
      purity: null,
      beltTier: null,
      storageMode: null,
      splurgerVariant: null,
    });
    const edge = addEdge(editor.sfmDoc, {
      containerId: "c_root",
      part: "Iron Ingot",
      fromNode: a.id,
      fromPort: "out",
      toNode: b.id,
      toPort: "in",
      style: null,
      labelPos: null,
    });
    await appendUpdate(project.id, editor.diff(), owner.id);
    expect(await fetchProjEdges(project.id)).toHaveLength(1);
    expect(await fetchProjNodes(project.id)).toHaveLength(2);

    removeEdge(editor.sfmDoc, edge.id);
    await appendUpdate(project.id, editor.diff(), owner.id);

    const edgeRowsAfterDelete = await fetchProjEdges(project.id);
    expect(edgeRowsAfterDelete).toHaveLength(0);
    // The nodes themselves weren't touched — only the edge was removed.
    expect(await fetchProjNodes(project.id)).toHaveLength(2);
  });

  it("materializes an empty document to zero rows in both tables (no crash on the empty-insert edge case)", async () => {
    const owner = await createTestUser("projection-empty-owner");
    const project = await createTestProject(owner.id);

    const editor = createDocEditor();
    // A no-op edit (touching meta, not nodes/edges) still triggers a
    // materialization via appendUpdate — asserts the empty-array guard in
    // `materializeProjection` doesn't throw when there's nothing to insert.
    editor.sfmDoc.doc.transact(() => {
      editor.sfmDoc.meta.set("title", "Empty Factory");
    });
    await appendUpdate(project.id, editor.diff(), owner.id);

    expect(await fetchProjNodes(project.id)).toHaveLength(0);
    expect(await fetchProjEdges(project.id)).toHaveLength(0);
  });
});
