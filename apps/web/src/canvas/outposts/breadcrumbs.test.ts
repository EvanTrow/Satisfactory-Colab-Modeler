import { addContainer, createDocument, type SfmDocument } from "@scm/ydoc";
import { describe, expect, it } from "vitest";

import { computeBreadcrumbPath } from "./breadcrumbs";

function makeFixture() {
  const sfmDoc: SfmDocument = createDocument();
  const root = addContainer(sfmDoc, {
    kind: "root",
    parentId: null,
    title: "Root",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  const outer = addContainer(sfmDoc, {
    kind: "outpost",
    parentId: root.id,
    title: "Outer",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  const inner = addContainer(sfmDoc, {
    kind: "outpost",
    parentId: outer.id,
    title: "Inner",
    color: "#4b5563",
    x: 0,
    y: 0,
    copiesLimit: null,
  });
  return { sfmDoc, root, outer, inner };
}

describe("computeBreadcrumbPath", () => {
  it("returns just the root when viewing root", () => {
    const { root } = makeFixture();
    expect(computeBreadcrumbPath(root.id, [root])).toEqual([root]);
  });

  it("reflects actual nesting depth, root first", () => {
    const { root, outer, inner } = makeFixture();
    const path = computeBreadcrumbPath(inner.id, [root, outer, inner]);
    expect(path.map((c) => c.id)).toEqual([root.id, outer.id, inner.id]);
  });

  it("returns a shorter path for a shallower container", () => {
    const { root, outer, inner } = makeFixture();
    const path = computeBreadcrumbPath(outer.id, [root, outer, inner]);
    expect(path.map((c) => c.id)).toEqual([root.id, outer.id]);
  });

  it("returns an empty array for an unknown container id", () => {
    const { root } = makeFixture();
    expect(computeBreadcrumbPath("c_missing", [root])).toEqual([]);
  });
});
