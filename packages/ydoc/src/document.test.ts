import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDocument, getMeta, getSettings, snapshotDocument } from "./document";

describe("createDocument", () => {
  it("populates default meta and settings on a brand-new doc", () => {
    const sfmDoc = createDocument();
    const meta = getMeta(sfmDoc);
    expect(meta.schemaVersion).toBe(1);
    expect(meta.title).toBe("Untitled Factory");

    const settings = getSettings(sfmDoc);
    expect(settings.solverMode).toBe("none");
    expect(settings.snapMachines).toBe(true);
    expect(settings.numberFormats.style).toBe("decimal");
  });

  it("applies meta/settings overrides passed to createDocument", () => {
    const sfmDoc = createDocument({
      meta: { title: "My Factory", gameDataVersion: "u8-1.0" },
      settings: { solverMode: "manual" },
    });
    expect(getMeta(sfmDoc).title).toBe("My Factory");
    expect(getMeta(sfmDoc).gameDataVersion).toBe("u8-1.0");
    expect(getSettings(sfmDoc).solverMode).toBe("manual");
  });

  it("does not clobber existing meta/settings when wrapping an already-populated doc", () => {
    const raw = new Y.Doc();
    const first = createDocument({ doc: raw, meta: { title: "Original" } });
    expect(getMeta(first).title).toBe("Original");

    // Re-wrapping the same underlying Y.Doc must not reset already-set fields.
    const second = createDocument({ doc: raw, meta: { title: "Should not apply" } });
    expect(getMeta(second).title).toBe("Original");
  });

  it("starts with empty containers/nodes/edges maps", () => {
    const sfmDoc = createDocument();
    const snapshot = snapshotDocument(sfmDoc);
    expect(snapshot.containers).toEqual([]);
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
  });
});
