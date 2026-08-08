// CRDT convergence fuzzing — PLAN.md §9's explicit verification requirement:
// "generate random concurrent operation sequences across N in-memory docs,
// apply in randomized orders, then assert (a) all docs are byte-identical
// and (b) every integrity invariant holds (no dangling edges, no orphaned
// nodes, shards within range)." Also exercises PLAN.md §8's Phase 5 exit
// criterion in its purest, fastest-to-run form: "concurrent delete-vs-
// connect converges with no dangling edges" is exactly what
// `randomOp`'s `removeNode`/`addEdge` combination produces, hundreds of
// times over, across randomized merge orders.
//
// Design (see this job's own Handoff notes in jobs/022-integrity-reducer.md
// for the full write-up):
//   1. N independent `Y.Doc`s start from one identical seed (a document
//      with just a root container), so their *content* starts equal while
//      their `clientID`s stay genuinely distinct (Yjs assigns one randomly
//      per `new Y.Doc()`) — real independent replicas, not clones of one
//      identity.
//   2. Each "round": every doc performs a small batch of random local
//      mutations (regular origin — exactly what a real user's edits look
//      like), then runs `runIntegrityReducer` locally (mirroring "runs
//      after every transaction, on both client and server"). Each doc's
//      diff-since-last-broadcast (fuzz ops AND its own repair pass) is then
//      applied to every OTHER doc, in a freshly-shuffled per-target order —
//      the "apply in randomized orders" requirement — via `Y.applyUpdate`.
//   3. After the fuzz rounds, a bounded number of settle rounds (repair +
//      broadcast + merge, no new ops) runs until a full round produces zero
//      repairs anywhere — the fixed point every replica converges to
//      independently, deterministically, from identical merged content.
//   4. Asserts: every doc's `Y.encodeStateAsUpdate()` bytes are pairwise
//      identical (the same byte-identical-convergence technique already
//      established in this repo — see `docStorage.test.ts`'s compaction
//      losslessness check), AND the converged state violates none of
//      PLAN.md §5's four invariants on every single doc.
import { defaultGameData, type GameData } from "@scm/gamedata";
import { isNegative } from "@scm/rational";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createDocument, listContainers, listEdges, listNodes, type SfmDocument } from "./document";
import { isNoopRepair, runIntegrityReducer } from "./integrity";
import { addContainer, addEdge, addNode, removeContainer, removeNode, updateNode } from "./mutations";
import type { ContainerKind, NodeRecord } from "./schema";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — every sequence is seeded by its own
// index, so a failure is reproducible by rerunning just that one iteration
// (`SEED=<n> vitest run src/fuzz.test.ts`-style debugging isn't wired up,
// but the seed is printed in every assertion message below).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  if (arr.length === 0) throw new Error("pick: empty array");
  return arr[Math.floor(rng() * arr.length)]!;
}

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** Fisher-Yates, seeded — the "apply in randomized orders" half of PLAN.md §9. */
function shuffled<T>(arr: readonly T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// A small pool of real recipes (verified against the real
// `resources/game_data/game_data.json` — the same fixture RecipeNode.tsx
// and this package's other tests use) so rule 3 (shard clamping / port
// dropping) has real machine/recipe data to validate against. "Plastic
// Smart Plating" on "Manufacturer" (MaxProductionShards 4, per PLAN.md §1's
// own worked example) is what exercises shard clamping; every entry's
// parts feed the valid-port set rule 3 checks edges against.
// ---------------------------------------------------------------------------
interface RecipePoolEntry {
  recipe: string;
  machine: string;
}

const RECIPE_POOL: readonly RecipePoolEntry[] = [
  { recipe: "Iron Ingot", machine: "Smelter" },
  { recipe: "Iron Rod", machine: "Constructor" },
  { recipe: "Iron Plate", machine: "Constructor" },
  { recipe: "Plastic Smart Plating", machine: "Manufacturer" },
];

const FALLBACK_PART_NAMES = [
  "Iron Ore",
  "Iron Ingot",
  "Iron Rod",
  "Iron Plate",
  "Screw",
  "Reinforced Iron Plate",
  "Rotor",
  "Plastic",
  "Smart Plating",
];

function portsOf(gameData: GameData, node: NodeRecord, direction: "in" | "out"): string[] {
  const recipe = node.recipe ? gameData.recipesByName.get(node.recipe) : undefined;
  if (!recipe) return [];
  return recipe.parts
    .filter((part) => (direction === "in" ? isNegative(part.amount) : !isNegative(part.amount)))
    .map((part) => `${direction}:${part.part}`);
}

// ---------------------------------------------------------------------------
// Random operation generator
// ---------------------------------------------------------------------------
type OpKind =
  | "addNode"
  | "addEdge"
  | "removeNode"
  | "addContainer"
  | "removeContainer"
  | "moveNode"
  | "changeRecipe"
  | "setShards";

// Weighted by repetition — adds/edges happen more often than deletes so a
// graph actually builds up before it gets torn at, but every op kind runs
// often enough across hundreds of sequences to matter.
const OP_WEIGHTS: readonly OpKind[] = [
  "addNode",
  "addNode",
  "addNode",
  "addEdge",
  "addEdge",
  "addEdge",
  "removeNode",
  "addContainer",
  "removeContainer",
  "moveNode",
  "changeRecipe",
  "setShards",
];

function performRandomOp(sfmDoc: SfmDocument, rng: () => number): void {
  const kind = pick(OP_WEIGHTS, rng);
  const containers = listContainers(sfmDoc);
  const nodes = listNodes(sfmDoc);

  switch (kind) {
    case "addNode": {
      const pool = pick(RECIPE_POOL, rng);
      const container = pick(containers, rng);
      addNode(sfmDoc, {
        containerId: container.id,
        kind: "recipe",
        recipe: pool.recipe,
        machine: pool.machine,
        x: randomInt(rng, 1000),
        y: randomInt(rng, 1000),
        title: pool.recipe,
        color: "#4b5563",
        limit: null,
        limitMode: "machines",
        clock: null,
        autoRound: false,
        // Deliberately allowed to exceed every pool machine's real max (4,
        // for Manufacturer) some of the time — rule 3 must clamp it back.
        shards: randomInt(rng, 8),
        purity: null,
        beltTier: null,
        storageMode: null,
        splurgerVariant: null,
      });
      return;
    }
    case "addEdge": {
      if (nodes.length < 2) return;
      const from = pick(nodes, rng);
      const toCandidates = nodes.filter((n) => n.id !== from.id);
      if (toCandidates.length === 0) return;
      const to = pick(toCandidates, rng);

      const outs = portsOf(defaultGameData, from, "out");
      const ins = portsOf(defaultGameData, to, "in");
      const overlapParts = outs
        .map((p) => p.slice("out:".length))
        .filter((part) => ins.includes(`in:${part}`));

      let part: string;
      let fromPort: string;
      let toPort: string;
      if (overlapParts.length > 0 && rng() < 0.7) {
        // A genuinely valid connection most of the time.
        part = pick(overlapParts, rng);
        fromPort = `out:${part}`;
        toPort = `in:${part}`;
      } else {
        // Deliberately maybe-invalid wiring — either a random part name a
        // pool recipe has never heard of, or one endpoint valid and the
        // other not. Exercises rule 3's port-drop.
        part = pick(FALLBACK_PART_NAMES, rng);
        fromPort = outs.length > 0 && rng() < 0.5 ? pick(outs, rng) : `out:${part}`;
        toPort = ins.length > 0 && rng() < 0.5 ? pick(ins, rng) : `in:${part}`;
      }

      addEdge(sfmDoc, {
        containerId: from.containerId,
        part,
        fromNode: from.id,
        fromPort,
        toNode: to.id,
        toPort,
        style: null,
        labelPos: null,
      });
      return;
    }
    case "removeNode": {
      if (nodes.length === 0) return;
      // Raw removal (no cascade — matches `removeNode`'s own documented
      // contract) is exactly "user A deletes a machine while user B's edge
      // still points at it" once this doc's diff merges elsewhere.
      removeNode(sfmDoc, pick(nodes, rng).id);
      return;
    }
    case "addContainer": {
      const parent = pick(containers, rng);
      const containerKind: ContainerKind = rng() < 0.8 ? "outpost" : "blueprint";
      addContainer(sfmDoc, {
        kind: containerKind,
        parentId: parent.id,
        title: "Outpost",
        color: "#4b5563",
        x: randomInt(rng, 1000),
        y: randomInt(rng, 1000),
        copiesLimit: containerKind === "blueprint" ? randomInt(rng, 5) : null,
      });
      return;
    }
    case "removeContainer": {
      const nonRoot = containers.filter((c) => c.kind !== "root");
      if (nonRoot.length === 0) return;
      // Raw removal (no reparent cascade — deliberately NOT
      // `apps/web`'s `deleteOutpost`, which is one specific client's own
      // local UI flow) is "user A deletes an outpost while user B still has
      // a node/nested-container inside it," the case this reducer's rule 2
      // has to catch regardless of *how* the container disappeared.
      removeContainer(sfmDoc, pick(nonRoot, rng).id);
      return;
    }
    case "moveNode": {
      if (nodes.length === 0) return;
      const node = pick(nodes, rng);
      const target = pick(containers, rng);
      updateNode(sfmDoc, node.id, { containerId: target.id });
      return;
    }
    case "changeRecipe": {
      if (nodes.length === 0) return;
      const node = pick(nodes, rng);
      const pool = pick(RECIPE_POOL, rng);
      // "User A changes a node's recipe while user B has an edge wired to a
      // port that no longer exists on the new recipe" — PLAN.md §5's own
      // wording for rule 3, verbatim.
      updateNode(sfmDoc, node.id, { recipe: pool.recipe, machine: pool.machine });
      return;
    }
    case "setShards": {
      if (nodes.length === 0) return;
      const node = pick(nodes, rng);
      updateNode(sfmDoc, node.id, { shards: randomInt(rng, 10) });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// N-doc harness
// ---------------------------------------------------------------------------
interface FuzzReplica {
  sfmDoc: SfmDocument;
  lastSyncVector: Uint8Array;
}

function createSeedBytes(): Uint8Array {
  const seed = createDocument();
  addContainer(seed, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return Y.encodeStateAsUpdate(seed.doc);
}

function createReplicas(n: number, seedBytes: Uint8Array): FuzzReplica[] {
  const replicas: FuzzReplica[] = [];
  for (let i = 0; i < n; i++) {
    // `gc: false` — Yjs's default garbage collection discards deleted
    // items' content once it decides they're no longer reachable, and *when*
    // that decision fires can depend on merge history/timing, not just
    // logical content. That's irrelevant to every other guarantee this
    // test cares about (JSON-level convergence, invariants) but would make
    // the literal `Y.encodeStateAsUpdate` byte-identical comparison PLAN.md
    // §9 asks for flaky for reasons that have nothing to do with the
    // integrity reducer itself. Disabling GC keeps full tombstone history on
    // every replica so the encoded bytes are a pure function of "which
    // operations did this replica's causal history receive," which is
    // exactly what this test wants to assert converges.
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, seedBytes);
    const sfmDoc = createDocument({ doc });
    replicas.push({ sfmDoc, lastSyncVector: Y.encodeStateVector(doc) });
  }
  return replicas;
}

/** Broadcasts every replica's diff-since-last-sync to every other replica, in a freshly shuffled order per target. */
function broadcastAndMerge(replicas: FuzzReplica[], rng: () => number): void {
  const diffs = replicas.map((r) => Y.encodeStateAsUpdate(r.sfmDoc.doc, r.lastSyncVector));

  replicas.forEach((target, targetIdx) => {
    const sourceOrder = shuffled(
      replicas.map((_, i) => i).filter((i) => i !== targetIdx),
      rng,
    );
    for (const sourceIdx of sourceOrder) {
      const diff = diffs[sourceIdx]!;
      if (diff.length > 0) {
        Y.applyUpdate(target.sfmDoc.doc, diff);
      }
    }
  });

  replicas.forEach((r) => {
    r.lastSyncVector = Y.encodeStateVector(r.sfmDoc.doc);
  });
}

const N_REPLICAS = 4;
const FUZZ_ROUNDS = 5;
const MAX_OPS_PER_ROUND = 3;
const MAX_SETTLE_ROUNDS = 6;

/** Runs one full fuzz sequence (fuzz rounds + settle-to-fixed-point) for a given seed. Throws (via `expect`) on any convergence or invariant violation. */
function runFuzzSequence(seed: number): void {
  const rng = mulberry32(seed);
  const label = `seed=${seed}`;
  const seedBytes = createSeedBytes();
  const replicas = createReplicas(N_REPLICAS, seedBytes);

  for (let round = 0; round < FUZZ_ROUNDS; round++) {
    for (const replica of replicas) {
      const opCount = randomInt(rng, MAX_OPS_PER_ROUND + 1);
      for (let i = 0; i < opCount; i++) {
        performRandomOp(replica.sfmDoc, rng);
      }
      runIntegrityReducer(replica.sfmDoc, defaultGameData);
    }
    broadcastAndMerge(replicas, rng);
  }

  // Settle phase: repair + broadcast with no new ops, until one full round
  // repairs nothing anywhere (the fixed point every replica reaches
  // independently and deterministically from identical merged content).
  let settledCleanRound = false;
  for (let round = 0; round < MAX_SETTLE_ROUNDS && !settledCleanRound; round++) {
    const summaries = replicas.map((r) => runIntegrityReducer(r.sfmDoc, defaultGameData));
    settledCleanRound = summaries.every(isNoopRepair);
    broadcastAndMerge(replicas, rng);
  }

  // One last repair with NO further merge after it — if every replica now
  // holds byte-identical merged content (asserted below), this must be a
  // true no-op everywhere. Asserting that here, before the merge that would
  // otherwise mask a divergence, is what makes this an actual convergence
  // proof rather than just "eventually stopped complaining."
  for (const replica of replicas) {
    const finalSummary = runIntegrityReducer(replica.sfmDoc, defaultGameData);
    expect(isNoopRepair(finalSummary), `${label}: expected a stable fixed point, got ${JSON.stringify(finalSummary)}`).toBe(
      true,
    );
  }

  assertByteIdenticalConvergence(replicas, label);
  for (const replica of replicas) {
    assertNoIntegrityViolations(replica.sfmDoc, label);
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
function assertByteIdenticalConvergence(replicas: FuzzReplica[], label: string): void {
  const encoded = replicas.map((r) => Buffer.from(Y.encodeStateAsUpdate(r.sfmDoc.doc)));
  const first = encoded[0]!;
  for (let i = 1; i < encoded.length; i++) {
    expect(encoded[i]!.equals(first), `${label}: replica ${i}'s encoded state differs from replica 0's`).toBe(true);
  }
}

/** Every PLAN.md §5 invariant, checked directly against the document (deliberately not delegating to `validate.ts`, which doesn't know about shards/ports/dedup — this is the fuzz test's own independent check that the reducer actually did its job). */
function assertNoIntegrityViolations(sfmDoc: SfmDocument, label: string): void {
  const containers = listContainers(sfmDoc);
  const containerIds = new Set(containers.map((c) => c.id));
  const nodes = listNodes(sfmDoc);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const edges = listEdges(sfmDoc);

  for (const container of containers) {
    if (container.kind === "root") continue;
    expect(container.parentId !== null && containerIds.has(container.parentId), `${label}: container ${container.id} has a dangling parentId`).toBe(true);
  }

  for (const node of nodes) {
    expect(containerIds.has(node.containerId), `${label}: node ${node.id} has a dangling containerId`).toBe(true);

    const machine = node.machine ? defaultGameData.machinesByName.get(node.machine) : undefined;
    if (machine) {
      const maxShards = machine.maxProductionShards ?? 0;
      expect(node.shards, `${label}: node ${node.id} shards ${node.shards} exceeds max ${maxShards}`).toBeLessThanOrEqual(
        maxShards,
      );
      expect(node.shards, `${label}: node ${node.id} shards is negative`).toBeGreaterThanOrEqual(0);
    }
  }

  const seenConnectionKeys = new Set<string>();
  for (const edge of edges) {
    expect(containerIds.has(edge.containerId), `${label}: edge ${edge.id} has a dangling containerId`).toBe(true);
    expect(nodeIds.has(edge.fromNode), `${label}: edge ${edge.id} has a dangling fromNode`).toBe(true);
    expect(nodeIds.has(edge.toNode), `${label}: edge ${edge.id} has a dangling toNode`).toBe(true);

    const fromNode = nodesById.get(edge.fromNode);
    if (fromNode) {
      const recipe = fromNode.recipe ? defaultGameData.recipesByName.get(fromNode.recipe) : undefined;
      if (recipe) {
        const validOutPorts = portsOf(defaultGameData, fromNode, "out");
        expect(validOutPorts.includes(edge.fromPort), `${label}: edge ${edge.id} fromPort ${edge.fromPort} invalid for recipe ${fromNode.recipe}`).toBe(true);
      }
    }
    const toNode = nodesById.get(edge.toNode);
    if (toNode) {
      const recipe = toNode.recipe ? defaultGameData.recipesByName.get(toNode.recipe) : undefined;
      if (recipe) {
        const validInPorts = portsOf(defaultGameData, toNode, "in");
        expect(validInPorts.includes(edge.toPort), `${label}: edge ${edge.id} toPort ${edge.toPort} invalid for recipe ${toNode.recipe}`).toBe(true);
      }
    }

    const key = `${edge.fromNode} ${edge.fromPort} ${edge.toNode} ${edge.toPort}`;
    expect(seenConnectionKeys.has(key), `${label}: duplicate edge for connection ${key}`).toBe(false);
    seenConnectionKeys.add(key);
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------
describe("CRDT convergence fuzzing (PLAN.md §9)", () => {
  // "A meaningful number of randomized sequences (e.g. hundreds)" per this
  // job's own acceptance criteria — 300 full sequences, each running
  // FUZZ_ROUNDS × N_REPLICAS random ops plus a full settle-to-fixed-point,
  // is comfortably in that range while staying fast (small graphs, pure
  // in-memory Yjs, no network/DB).
  const SEQUENCE_COUNT = 300;

  it(`converges byte-identically with zero integrity violations across ${SEQUENCE_COUNT} random sequences`, () => {
    for (let seed = 0; seed < SEQUENCE_COUNT; seed++) {
      runFuzzSequence(seed);
    }
  });

  it("specifically covers the delete-vs-connect race (PLAN.md §8's Phase 5 exit criterion) with no dangling edges", () => {
    // A hand-aimed two-replica scenario, on top of the general fuzz above:
    // replica A deletes a node; replica B, unaware, concurrently connects a
    // new edge to that same node. Merging must converge with the edge gone,
    // not dangling.
    const seedBytes = createSeedBytes();
    const [a, b] = createReplicas(2, seedBytes) as [FuzzReplica, FuzzReplica];

    const shared = addNode(a.sfmDoc, {
      containerId: listContainers(a.sfmDoc)[0]!.id,
      kind: "recipe",
      recipe: "Iron Ingot",
      machine: "Smelter",
      x: 0,
      y: 0,
      title: "Shared",
      color: "#4b5563",
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
    broadcastAndMerge([a, b], mulberry32(1));

    const other = addNode(b.sfmDoc, {
      containerId: listContainers(b.sfmDoc)[0]!.id,
      kind: "recipe",
      recipe: "Iron Rod",
      machine: "Constructor",
      x: 100,
      y: 0,
      title: "Other",
      color: "#4b5563",
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
    broadcastAndMerge([a, b], mulberry32(2));

    // Concurrent, un-synced: A deletes the shared node...
    removeNode(a.sfmDoc, shared.id);
    // ...while B, not yet aware, wires a fresh edge to it.
    addEdge(b.sfmDoc, {
      containerId: listContainers(b.sfmDoc)[0]!.id,
      part: "Iron Ingot",
      fromNode: shared.id,
      fromPort: "out:Iron Ingot",
      toNode: other.id,
      toPort: "in:Iron Ingot",
      style: null,
      labelPos: null,
    });

    runIntegrityReducer(a.sfmDoc, defaultGameData);
    runIntegrityReducer(b.sfmDoc, defaultGameData);
    broadcastAndMerge([a, b], mulberry32(3));
    runIntegrityReducer(a.sfmDoc, defaultGameData);
    runIntegrityReducer(b.sfmDoc, defaultGameData);
    broadcastAndMerge([a, b], mulberry32(4));

    for (const replica of [a, b]) {
      const edges = listEdges(replica.sfmDoc);
      expect(edges.find((e) => e.fromNode === shared.id)).toBeUndefined();
      assertNoIntegrityViolations(replica.sfmDoc, "delete-vs-connect");
    }
    assertByteIdenticalConvergence([a, b], "delete-vs-connect");
  });
});
