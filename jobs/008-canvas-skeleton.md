# Job 008: Canvas skeleton (React Flow + local Yjs doc)

**Phase:** 2 · Solo canvas editor
**Status:** Done
**Depends on:** 007 (`packages/ydoc`)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** (pan/zoom row) and **7. Project Structure** (`apps/web/src/canvas/`, key-libraries table: `@xyflow/react`). This job wires React Flow to a **local, in-memory** Yjs document (via `packages/ydoc` from Job 007) with no persistence and no game data yet — just the empty canvas that later jobs populate with real nodes.

## Scope

In scope:
- `apps/web/src/canvas/` setup: a React Flow `<ReactFlow>` instance backed by a Zustand store (per PLAN.md's "State" row: "Zustand for ephemeral UI state only — the document lives in Yjs") that subscribes to the `packages/ydoc` document's `nodes`/`edges`/`containers` maps and keeps React Flow's node/edge arrays in sync via Yjs observers.
- Infinite pan/zoom canvas (React Flow's built-in behavior is sufficient — drag background to pan, scroll wheel to zoom, matching PLAN.md §2).
- A route in `apps/web` that mounts the canvas for a given project (for now, project ID can come from the route param but the doc itself is created fresh in memory each load — no fetch, no persistence; that's Job 015).
- The Zustand↔Yjs sync must be bidirectional at the wiring level even though nothing populates it yet: a manually-added test node (e.g. via a dev-only button or test harness) must appear on canvas, and dragging it must write the new `x,y` back into the Yjs doc.
- Empty-canvas state / placeholder background.

Out of scope:
- Recipe Chooser, real recipe nodes (Jobs 009/010).
- Connections/waypoints (Job 011).
- Selection, cut/copy/paste/undo (Job 012).
- Outposts navigation (Job 013).
- Any visual/theming polish (Job 014) — functional plumbing only here.
- Persistence of any kind (Jobs 015/016).

## Deliverables

- `apps/web/src/canvas/CanvasView.tsx` (or similar) rendering `<ReactFlow>` bound to the Yjs-backed store.
- `apps/web/src/canvas/useYjsSync.ts` (or similar) — the Zustand store + Yjs observer wiring.
- A route (e.g. `/p/:shortId/edit`) mounting the canvas.
- A minimal manual test path (dev button, Storybook story, or test) proving a node added via the ydoc API renders on canvas and position edits round-trip back into the doc.

## Acceptance criteria

- Panning and zooming work smoothly on an empty canvas.
- Programmatically calling `packages/ydoc`'s `addNode` (from Job 007) results in a node rendering on the React Flow canvas without a page reload.
- Dragging a node in React Flow updates that node's `x`/`y` in the underlying Yjs document (verify by reading the doc state after a drag in a test or dev console).
- No direct Yjs map/array manipulation happens inside `apps/web` — all doc access goes through `packages/ydoc`'s public API (per Job 007's architectural constraint).
- `pnpm --filter web dev` runs the canvas with no console errors; `pnpm --filter web build/typecheck` pass.

## Notes for the worker

- This is plumbing-only — resist the urge to build real node visuals here; Job 010 owns node UI.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).

## Handoff notes

### What got built

- `apps/web/src/canvas/CanvasDocContext.ts` — a plain `React.createContext` (no provider library) holding `{ sfmDoc: SfmDocument; containerId: string }`. `useCanvasDoc()` reads it and throws if called outside `<CanvasView>`. `containerId` is always the root container's id for now (there's no outpost drill-in yet — Job 013) — every node created anywhere in this job's UI, and every node Job 009's Recipe Chooser will create, goes into that one root container.
- `apps/web/src/canvas/useYjsSync.ts` — the Zustand store + Yjs observer wiring. Exports `useYjsSync(sfmDoc): UseYjsSyncResult` (`{ nodes, edges, containers, onNodesChange, onEdgesChange, onNodeDragStop }`), plus the pure mapping helpers `nodeRecordToFlowNode`/`edgeRecordToFlowEdge` and the `CanvasNode`/`CanvasEdge`/`CanvasNodeData` types (`CanvasNodeData = { record: NodeRecord; label: string }` — the full `NodeRecord` rides along in `data.record` for whoever needs it next; `label` exists only so React Flow's built-in `"default"` node type has something to render, since this job builds no real node UI).
- `apps/web/src/canvas/CanvasView.tsx` — creates one `SfmDocument` per mount via `useMemo(createLocalCanvasDocument, [])` (fresh in-memory doc, no fetch, no persistence — Job 015), creates its root container via `addContainer`, wires `useYjsSync` to a `<ReactFlow>` instance with `<Background variant={BackgroundVariant.Dots}>` and `<Controls>`, and renders `<DevNodeTools>` as a `<Panel>` inside the flow. Wraps everything in `<CanvasDocContext.Provider>`.
- `apps/web/src/canvas/DevNodeTools.tsx` — the "minimal manual test path" deliverable: a `<Panel position="top-left">` with an "Add test node (calls addNode)" button that calls `@scm/ydoc`'s `addNode` directly with `kind: "debug"` (deliberately not one of `KNOWN_NODE_KINDS`, so it's obviously not a real recipe node in the doc). This is **not** the Recipe Chooser — Job 009 builds that as a real UI; this is scaffolding-only and can be deleted or left alongside it once Job 009 lands (it doesn't conflict with anything).
- `apps/web/src/canvas/index.ts` — barrel export of `CanvasView`, `CanvasDocContext`/`useCanvasDoc`, and everything from `useYjsSync.ts`.
- `apps/web/src/App.tsx` — the `View` union's `"project"` variant is renamed `"canvas"` and now renders `<CanvasView>` instead of the deleted `ProjectPlaceholder`. Added `enterCanvas`/`leaveCanvas` callbacks that also call `window.history.pushState` to put `/p/:shortId/edit` in the address bar (and a `popstate` listener so the browser back button exits the canvas) — see the big comment on the `View` type for why this is **not** a real deep link (refreshing at that URL boots back to the project list; wiring a real one needs a `GET /api/projects/by-short-id/:shortId`-style endpoint that doesn't exist, which is backend work explicitly out of this job's scope). When `view.name === "canvas"`, `App` renders `<CanvasView>` as the *only* thing in `<main>` (no shared header) so React Flow gets the full viewport — `CanvasView` renders its own compact back-button/title bar instead.
- `apps/web/src/routes/ProjectPlaceholder.tsx` — **deleted**. Its only caller was `App.tsx`, which now renders `CanvasView` in its place; nothing else referenced it.
- `apps/web/package.json` — added `@scm/ydoc: workspace:*`, `@xyflow/react: ^12.11.2`, `zustand: ^5.0.14` (all three named in PLAN.md §7's key-libraries table, none previously installed anywhere in the repo).
- `.claude/launch.json` — added (new file, wasn't in the repo before) so `apps/web`'s dev server can be driven by the Browser preview tools (`pnpm --filter web dev` on port 5173); used for this job's manual verification and left in place since later canvas jobs (009+) will want the same thing.

### Data flow — precise, since this is the thing later jobs most need to get right

**One-way from Yjs to the UI, with one deliberate, temporary exception during an active drag:**

1. `sfmDoc.nodes` / `sfmDoc.edges` / `sfmDoc.containers` (`Y.Map`s on the `SfmDocument`) are the only source of truth.
2. `useYjsSync` calls `.observeDeep()` on all three (not just `.observe()`, so field-level changes inside an existing node/edge/container's `Y.Map` — e.g. any `updateNode`/`moveNode` call, not just add/remove — trigger a resync too).
3. Every observer callback does a **full re-read** (`listNodes(sfmDoc).map(nodeRecordToFlowNode)`, etc.) and calls the Zustand store's `setNodes`/`setEdges`/`setContainers` — no incremental patching. This is deliberate: it's simple, cheap at the node counts this app deals in (PLAN.md §2: "tens to low hundreds per outpost"), and guarantees the store can never drift from the doc.
4. React Flow renders straight from the Zustand store's `nodes`/`edges` arrays.
5. **The one exception:** `onNodesChange` (React Flow's per-frame change callback, fired continuously while dragging) applies changes *locally* to the store via `applyNodeChanges` — it does **not** touch the Yjs doc. This is what makes dragging feel smooth at 60fps instead of round-tripping through a full Yjs resync on every mouse-move tick. The doc is only written once, in `onNodeDragStop`, via `moveNode(sfmDoc, node.id, node.position.x, node.position.y)` — `@scm/ydoc`'s mutation helper, never a hand-built `Y.Map` write. That write fires the observer from step 2, which resyncs the store — overwriting the just-dragged position with the (identical) persisted value, so there's no visible jump.

So: **all durable writes originate from `@scm/ydoc`'s `mutations.ts` helpers** (`addNode`/`moveNode`/etc.), called either from `DevNodeTools.tsx` (this job) or — starting with Job 009 — from panel/modal components via `useCanvasDoc()`. The Zustand store is a derived cache, never an independent source of truth, except for the sub-second window between a drag frame and `onNodeDragStop`.

### Reaching the canvas

Log in → click a project on the project list (`ProjectsPage.tsx`, Job 006) → `App.tsx`'s `enterCanvas` switches `view.name` to `"canvas"` and mounts `<CanvasView>` with a **brand-new in-memory `SfmDocument`** (nothing is fetched or restored — every visit starts empty until Job 015). The address bar shows `/p/<shortId>/edit` but that's cosmetic only (see the App.tsx notes above) — there's no way to land on the canvas via a fresh URL load yet.

For manual/dev testing without going through Discord OAuth (this job needs no backend and Docker/Postgres weren't run), the verification for this job was done by temporarily swapping `main.tsx` to mount `<CanvasView>` directly instead of `<App>`, then reverting that swap before committing — `main.tsx` in the committed tree is unchanged from Job 006. A future job wanting a real no-login dev entry point would need to build that deliberately (not currently provided).

### What Job 009 (Recipe Chooser) needs to know

- **Getting the live doc + mutation functions:** call `useCanvasDoc()` from `apps/web/src/canvas/CanvasDocContext.ts` (re-exported via `apps/web/src/canvas`) from any component rendered underneath `<CanvasView>` (e.g. the Recipe Chooser modal, if it's rendered as a sibling of `<ReactFlow>` inside `CanvasView.tsx`, or anywhere further down). It returns `{ sfmDoc, containerId }`. Then `import { addNode } from "@scm/ydoc"` and call `addNode(sfmDoc, { containerId, kind: "recipe", ... })` directly — `@scm/ydoc`'s mutation helpers are plain functions, not bound to context, so no extra wiring is needed beyond getting `sfmDoc` itself.
- **Hooking "double/right-click the canvas background":** `<ReactFlow>` (rendered in `CanvasView.tsx`) currently has **no** pane click/context-menu handlers wired up — you'll add `onPaneContextMenu` (exists as a real prop, fires on right-click) directly, but **there is no `onPaneDoubleClick` prop in `@xyflow/react` v12** — double-click detection on the pane isn't built in. You'll need either a manual timestamp-based double-click check inside `onPaneClick`, or a native `ondblclick`/`onDoubleClick` listener on the wrapping `<div>` around `<ReactFlow>`. Also note **`zoomOnDoubleClick` defaults to `true`** on `<ReactFlow>` — leaving it on means a background double-click will zoom in *and* (if you also wire double-click detection) open the Recipe Chooser at the same time, which is almost certainly not what you want; set `zoomOnDoubleClick={false}` when you add the double-click handler.
- **Where to add these handlers:** directly on the `<ReactFlow>` element in `CanvasView.tsx` (or lift `CanvasView` to accept new callback props if you'd rather keep the Recipe Chooser's state/modal entirely in its own module and pass handlers down — either is fine, nothing here locks you into one approach).
- **Node kind convention:** this job's dev-only test nodes use `kind: "debug"`, deliberately not in `KNOWN_NODE_KINDS` (`["recipe", "splurger", "storage", "outpost"]` from `@scm/ydoc`'s `schema.ts`). Real recipe nodes from the Recipe Chooser should use `kind: "recipe"`.
- **Rendering:** `CanvasNodeData` (`useYjsSync.ts`) only carries `{ record, label }` and every node currently renders via React Flow's built-in `"default"` type (a plain white box showing `label`). Job 010 (not 009) is what gives recipe nodes real visuals/a custom node type — Job 009 only needs `addNode` to result in *something* showing up, which it will, just as an unstyled box with the recipe/machine's chosen title.
- **containers map is already observed** (`useYjsSync`'s `containers` state) but nothing renders from it yet — safe to ignore unless Job 009 needs container data for some other reason.

### Dependencies added

- `@xyflow/react` `^12.11.2`, `zustand` `^5.0.14` (both named in PLAN.md §7's key-libraries table, first use anywhere in the repo), `@scm/ydoc` `workspace:*` — all three in `apps/web/package.json`. No new dependency on `yjs` itself was needed in `apps/web` — TypeScript resolves `Y.Map`/`Y.Doc` types transitively through `@scm/ydoc`'s own `node_modules` without a direct `apps/web` dependency, and this file never imports from `"yjs"` directly (per the architectural constraint: all doc access goes through `@scm/ydoc`).

### Verification actually performed

- `pnpm --filter web typecheck` — clean.
- `pnpm --filter web build` — clean (one pre-existing-pattern warning: the production JS chunk is >500KB post-`@xyflow/react`, a `vite`-level suggestion to code-split, not an error; not addressed here as it's a polish concern, not a functional one).
- `pnpm -r build` and `pnpm -r typecheck` — clean across all 9 buildable workspaces.
- `pnpm -r test` — `packages/ydoc` (25 tests) and `packages/gamedata` (40 tests) pass; `apps/api`'s suite fails on `password authentication failed for user "scm"` (no local Postgres running) — the same pre-existing, unrelated failure Job 007 documented; confirmed via `git status` that no `apps/api` file was touched by this job. `apps/web` has no `test` script (no automated tests were added — the manual test path chosen was the `DevNodeTools` dev button plus live browser verification, both described above; `pnpm --filter web test` is a silent no-op).
- `pnpm lint` — clean, exit 0.
- **Manual browser verification (actually driven via the Browser MCP tools, not just read from code):**
  - Started `apps/web`'s dev server via the new `.claude/launch.json`, temporarily pointed `main.tsx` at `<CanvasView>` directly (bypassing the Discord-auth-gated `App` shell, since this job needs no backend/login), then reverted `main.tsx` afterward — confirmed via `git diff` that it ended up byte-identical to its pre-job state.
  - **Pan:** dragged the empty canvas background; confirmed via `document.querySelector('.react-flow__viewport').style.transform` that the `translate(...)` values changed to match the drag.
  - **Zoom:** scrolled the mouse wheel over the canvas; confirmed the same element's `scale(...)` changed from `1` to `2`.
  - **`addNode` → renders without reload:** clicked "Add test node" twice; both "Test node 1" and "Test node 2" appeared on the canvas with no page reload, and `window.__sfmDoc.nodes` (inspected via the dev console, per this job's `import.meta.env.DEV`-only `window.__sfmDoc` hook in `CanvasView.tsx`) showed both records with the expected fields.
  - **Drag → doc write-back:** dragged "Test node 2" ~200px down on screen; confirmed via `window.__sfmDoc.nodes` in the console that its `y` value changed in the doc (80 → 145) while `x` stayed put (pure vertical drag) — the concrete acceptance-criteria check this job calls for.
  - **No direct `Y.Map`/`Y.Array` manipulation:** confirmed by construction (see Data flow section) — `apps/web` only ever calls `@scm/ydoc`'s exported functions; `useYjsSync.ts`'s observers read via `listNodes`/`listEdges`/`listContainers`, never by destructuring a `Y.Map` by hand.
  - **Console errors:** checked after each interaction and after a fresh full reload — zero errors from any of this job's code. (Stale `401`/`400` console entries appeared in one read but were confirmed, by timestamp/content, to be leftover from an unrelated prior Job 006 auth-flow test session in the same reused browser tab, not from anything this job touched.)
  - Also sanity-checked the real, non-bypassed `App.tsx` entry point after reverting `main.tsx`: it still renders the "Log in with Discord" gate correctly with no console errors, confirming the `App.tsx` changes (the `"project"` → `"canvas"` rename, `enterCanvas`/`leaveCanvas`, `popstate` handling) didn't break the pre-canvas flow.
  - StrictMode double-invoke sanity check: after the two `addNode` calls above, `window.__sfmDoc.containers.size === 1` and `.nodes.size === 2` — exactly as expected, no duplicate root container or duplicate nodes from React 19 StrictMode's development-mode double-render.

### Deviations from the spec / things flagged for later jobs

- The job file suggests the route path `/p/:shortId/edit` as an example; that exact path is what's pushed into the address bar, but (as explained above) it's cosmetic only — there is still no router library and no deep-link support. This matches the job's own wording ("A route... mounting the canvas") loosely but not to the letter of "a route" in the React-Router sense; flagging in case a later job (015 persistence, or whenever shareable URLs matter) wants to revisit this properly, likely alongside adding the `GET /api/projects/by-short-id/:shortId`-shaped endpoint it would need.
- `ProjectPlaceholder.tsx` (Job 006) was deleted rather than kept around unused, since `CanvasView` fully replaces its role and nothing else referenced it.
- A root container (`kind: "root"`) is created via `addContainer` on every fresh document — PLAN.md's schema requires every node to have a non-null `containerId`, and this job has no outpost UI yet to create one some other way. Job 013 (outposts) should confirm this convention (one root container per document, created eagerly) still holds once real container hierarchy exists; nothing here assumes a particular root container id or title beyond "whatever `addContainer` returned."
- No automated `apps/web` tests were added (see Verification section) — the job description offered "dev button, Storybook story, or test" as equally valid options for the manual test path, and the dev button plus live browser verification was chosen given `apps/web` has no existing test/RTL infrastructure to build on. If a later job wants automated coverage of the sync logic, `useYjsSync`'s pure helpers (`nodeRecordToFlowNode`/`edgeRecordToFlowEdge`) and the store's reducer-style `set*` functions are structured to be easy to unit-test in isolation from React Flow/DOM.
- `.claude/launch.json` is new infrastructure (not requested by the job file) added purely to enable the Browser-MCP-driven manual verification above; left in the repo since later canvas jobs will very likely want the same dev-server preview capability.
