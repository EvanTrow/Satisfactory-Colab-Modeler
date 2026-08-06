# Job Queue

Tracks the breakdown of [`PLAN.md`](../PLAN.md) into worker-chat-sized jobs. One job runs at a time — a job's status must reach **Done** (or be explicitly abandoned) before the next one starts. Update the **Status** column as jobs progress; each job also carries its own status line in its file.

Every job file is self-contained: it names its PLAN.md section(s), its dependencies, its deliverables, and its acceptance criteria, so a fresh worker chat with no prior context can pick it up.

| # | Job | Phase | Depends on | Status |
|---|---|---|---|---|
| 001 | [Monorepo scaffold](001-monorepo-scaffold.md) | 0 · Foundations | — | Done |
| 002 | [`packages/rational`](002-rational-package.md) | 0 · Foundations | 001 | Done |
| 003 | [`packages/gamedata`](003-gamedata-package.md) | 0 · Foundations | 001 | Done |
| 004 | [Core DB migrations](004-db-migrations-core.md) | 1 · Auth & projects | 001 | Done |
| 005 | [Discord OAuth2](005-discord-oauth.md) | 1 · Auth & projects | 004 | Done |
| 006 | [Project list UI](006-project-list-ui.md) | 1 · Auth & projects | 005 | Done |
| 007 | [`packages/ydoc` schema](007-ydoc-schema.md) | 2 · Solo canvas editor | 001 | Done |
| 008 | [Canvas skeleton](008-canvas-skeleton.md) | 2 · Solo canvas editor | 007 | Done |
| 009 | [Recipe Chooser](009-recipe-chooser.md) | 2 · Solo canvas editor | 008, 003 | Done |
| 010 | [Recipe node UI](010-recipe-node-ui.md) | 2 · Solo canvas editor | 009 | Done |
| 011 | [Connections & waypoints](011-connections-waypoints.md) | 2 · Solo canvas editor | 010 | Done |
| 012 | [Selection & editing](012-selection-editing.md) | 2 · Solo canvas editor | 011 | Done |
| 013 | [Outposts](013-outposts.md) | 2 · Solo canvas editor | 012 | Done |
| 014 | [Visual pass & theming](014-visual-pass.md) | 2 · Solo canvas editor | 013 | Done |
| 015 | [Doc persistence](015-doc-persistence.md) | 3 · Persistence | 014, 006 | Not started |
| 016 | [IndexedDB cache & versions](016-indexeddb-versions.md) | 3 · Persistence | 015 | Not started |
| 017 | [Solver core](017-solver-core.md) | 4 · Calculators | 002 | Not started |
| 018 | [Solver worker host](018-solver-worker.md) | 4 · Calculators | 017, 016 | Not started |
| 019 | [Summary panel & formats](019-summary-panel.md) | 4 · Calculators | 018 | Not started |
| 020 | [Hocuspocus server](020-hocuspocus-server.md) | 5 · Multiplayer | 019 | Not started |
| 021 | [Presence](021-presence.md) | 5 · Multiplayer | 020 | Not started |
| 022 | [Integrity reducer & sharing](022-integrity-reducer.md) | 5 · Multiplayer | 021 | Not started |
| 023 | [Full calculator](023-full-calculator.md) | 6 · Full calculator | 022 | Not started |
| 024 | [Priority node types](024-priority-nodes.md) | 6 · Full calculator | 023 | Not started |
| 025 | [Relational projection](025-relational-projection.md) | 6 · Full calculator | 024 | Not started |
| 026 | [Blueprints](026-blueprints.md) | 7 · Polish & deploy | 025 | Not started |
| 027 | [Auto-round, styles, minimap](027-polish-misc.md) | 7 · Polish & deploy | 026 | Not started |
| 028 | [i18n wiring](028-i18n.md) | 7 · Polish & deploy | 027 | Not started |
| 029 | [Accessibility & deploy](029-a11y-deploy.md) | 7 · Polish & deploy | 028 | Not started |

**Phase 1 (Auth & projects) is now fully complete** as of Job 006 — Discord OAuth2 login, sessions, and project CRUD (create/rename/duplicate/soft-delete) with role enforcement are all in place. Phase 2 (Solo canvas editor) starts next at Job 007, which builds `packages/ydoc`'s CRDT schema independently of any of Job 006's routes, but depends on `projects` existing (Job 004) to eventually attach documents to.

**Phase 2 (Solo canvas editor) is now fully complete** as of Job 014 — a local-Yjs-doc React Flow canvas with the Recipe Chooser, real recipe node UI, drag-to-connect with waypoints, marquee select/cut/copy/paste/delete/undo/redo, outposts with drill-in and breadcrumbs, a Ferrumium-inspired visual pass with dark/light theming, and snap-to-grid for both machines and waypoints are all in place. Phase 3 (Persistence) starts next at Job 015, which needs `Settings` (and the rest of the document) to actually survive a reload.

## Conventions for every job file

- **Depends on** means those jobs' deliverables must exist and pass their acceptance criteria first.
- **Out of scope** lines exist to stop a worker from scope-creeping into the *next* job — that's a feature, not a gap.
- Workers should update their own job file's **Status** line (`Not started` → `In progress` → `Done`) and this table when they finish, and leave a short **Handoff notes** section if anything relevant to later jobs was discovered mid-work.
- Jobs 020+ assume 015/016 (persistence) already landed, since multiplayer without persistence is pointless to build against.
