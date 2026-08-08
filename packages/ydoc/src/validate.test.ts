import { describe, expect, it } from "vitest";
import { createDocument, snapshotDocument } from "./document";
import { addContainer, addEdge, addNode, removeNode } from "./mutations";
import { validateDocumentSnapshot } from "./validate";

function setUp() {
  const sfmDoc = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#000000",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root };
}

function node(containerId: string) {
  return {
    containerId,
    kind: "recipe",
    recipe: "Recipe_IronPlate_C",
    machine: "Constructor",
    x: 0,
    y: 0,
    title: "",
    color: "#ffffff",
    limit: null,
    limitMode: "machines" as const,
    clock: null,
    autoRound: false,
    shards: 0,
    purity: null,
    beltTier: null,
    storageMode: null,
    splurgerVariant: null,
  };
}

describe("validateDocumentSnapshot", () => {
  it("reports no issues for a well-formed document", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, node(root.id));
    const b = addNode(sfmDoc, node(root.id));
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    const result = validateDocumentSnapshot(snapshotDocument(sfmDoc));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags an edge whose endpoint node no longer exists", () => {
    const { sfmDoc, root } = setUp();
    const a = addNode(sfmDoc, node(root.id));
    const b = addNode(sfmDoc, node(root.id));
    addEdge(sfmDoc, {
      containerId: root.id,
      part: "Desc_IronPlate_C",
      fromNode: a.id,
      fromPort: "out-0",
      toNode: b.id,
      toPort: "in-0",
      style: null,
      labelPos: null,
    });

    removeNode(sfmDoc, b.id);

    const result = validateDocumentSnapshot(snapshotDocument(sfmDoc));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "edges[0].toNode" }),
    );
  });

  it("flags a container whose parentId does not exist", () => {
    const { sfmDoc } = setUp();
    const orphan = addContainer(sfmDoc, {
      kind: "outpost",
      parentId: "missing-parent",
      title: "Outpost",
      color: "#111111",
      x: 0,
      y: 0,
      copiesLimit: null,
    });

    const result = validateDocumentSnapshot(snapshotDocument(sfmDoc));
    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.path.endsWith("parentId") && issue.message.includes(orphan.parentId ?? ""),
      ),
    ).toBe(true);
  });

  it("flags a shape violation (wrong type) via the underlying zod schema", () => {
    const { sfmDoc, root } = setUp();
    addNode(sfmDoc, node(root.id));
    const snapshot = snapshotDocument(sfmDoc);
    // Corrupt a plain-object snapshot field to simulate a malformed record.
    const corrupted = {
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], shards: "not-a-number" }],
    } as unknown as import("./document").DocumentSnapshot;

    const result = validateDocumentSnapshot(corrupted);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === "nodes[0].shards")).toBe(true);
  });
});
