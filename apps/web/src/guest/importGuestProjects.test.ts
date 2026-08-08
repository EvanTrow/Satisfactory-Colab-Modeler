// Guest-mode work: `importGuestProjectsToAccount`'s orchestration logic,
// with every dependency mocked — `readGuestProjectDocBytes`/`deleteProject`
// (real IndexedDB, `y-indexeddb`) and `createProject`/`pushInitialDocUpdate`
// (real network) both need a live browser/server to actually run, neither
// of which this repo's Node-only Vitest environment provides (see
// `vitest.config.ts`'s own header comment — no other file under
// `canvas/persistence`/`guest` that touches IndexedDB is unit-tested here
// either, for the same reason). What's actually worth covering without
// either of those is the per-project sequencing this file adds on top: every
// guest project gets its own independent attempt, a failure doesn't stop
// the rest, and only a project that's fully succeeded gets deleted locally.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GuestProjectSummary } from "./localProjects";

const { createProjectMock, pushInitialDocUpdateMock, listProjectsMock, deleteProjectMock, readGuestProjectDocBytesMock } =
  vi.hoisted(() => ({
    createProjectMock: vi.fn(),
    pushInitialDocUpdateMock: vi.fn(),
    listProjectsMock: vi.fn(),
    deleteProjectMock: vi.fn(),
    readGuestProjectDocBytesMock: vi.fn(),
  }));

vi.mock("../api/projects", () => ({ createProject: createProjectMock }));
vi.mock("../canvas", () => ({ pushInitialDocUpdate: pushInitialDocUpdateMock }));
vi.mock("./localProjects", () => ({
  listProjects: listProjectsMock,
  deleteProject: deleteProjectMock,
  readGuestProjectDocBytes: readGuestProjectDocBytesMock,
}));

function guestProject(id: string, title: string): GuestProjectSummary {
  return { id, title, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" };
}

describe("importGuestProjectsToAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports every guest project and deletes each one locally once seeded", async () => {
    const { importGuestProjectsToAccount } = await import("./importGuestProjects");

    listProjectsMock.mockResolvedValue([guestProject("g1", "First Factory"), guestProject("g2", "Second Factory")]);
    readGuestProjectDocBytesMock.mockImplementation(async (id: string) => new Uint8Array([id.length]));
    createProjectMock.mockImplementation(async (title: string) => ({ id: `cloud-${title}`, title }));
    pushInitialDocUpdateMock.mockResolvedValue(undefined);
    deleteProjectMock.mockResolvedValue(undefined);

    const summary = await importGuestProjectsToAccount();

    expect(summary).toEqual({ imported: 2, failed: 0 });
    expect(createProjectMock).toHaveBeenCalledWith("First Factory");
    expect(createProjectMock).toHaveBeenCalledWith("Second Factory");
    expect(pushInitialDocUpdateMock).toHaveBeenCalledWith("cloud-First Factory", new Uint8Array([2]));
    expect(pushInitialDocUpdateMock).toHaveBeenCalledWith("cloud-Second Factory", new Uint8Array([2]));
    expect(deleteProjectMock).toHaveBeenCalledWith("g1");
    expect(deleteProjectMock).toHaveBeenCalledWith("g2");
  });

  it("continues past a failed project and never deletes its (still un-imported) guest copy", async () => {
    const { importGuestProjectsToAccount } = await import("./importGuestProjects");

    listProjectsMock.mockResolvedValue([guestProject("bad", "Broken"), guestProject("good", "Fine")]);
    readGuestProjectDocBytesMock.mockResolvedValue(new Uint8Array([1]));
    createProjectMock.mockImplementation(async (title: string) => {
      if (title === "Broken") throw new Error("network down");
      return { id: "cloud-good", title };
    });
    pushInitialDocUpdateMock.mockResolvedValue(undefined);
    deleteProjectMock.mockResolvedValue(undefined);

    const summary = await importGuestProjectsToAccount();

    expect(summary).toEqual({ imported: 1, failed: 1 });
    expect(deleteProjectMock).not.toHaveBeenCalledWith("bad");
    expect(deleteProjectMock).toHaveBeenCalledWith("good");
  });

  it("adds every guest project as new, never skipping any because the account already has projects", async () => {
    // `createProject`/`pushInitialDocUpdate` here know nothing about what
    // the account already contains — this orchestration never queries
    // existing cloud projects before deciding whether to import, so an
    // account that already has 50 projects gets exactly the same behavior
    // as an empty one. This test exists to pin that absence down: nothing
    // here should ever start checking `listProjects` from `../api/projects`.
    const { importGuestProjectsToAccount } = await import("./importGuestProjects");

    listProjectsMock.mockResolvedValue([guestProject("g1", "Only Guest Project")]);
    readGuestProjectDocBytesMock.mockResolvedValue(new Uint8Array([9]));
    createProjectMock.mockResolvedValue({ id: "cloud-1", title: "Only Guest Project" });
    pushInitialDocUpdateMock.mockResolvedValue(undefined);
    deleteProjectMock.mockResolvedValue(undefined);

    const summary = await importGuestProjectsToAccount();

    expect(summary).toEqual({ imported: 1, failed: 0 });
    expect(createProjectMock).toHaveBeenCalledTimes(1);
  });
});
