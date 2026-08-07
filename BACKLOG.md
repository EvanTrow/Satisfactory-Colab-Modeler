# Backlog — Continued Development

Everything below was flagged by name across the 29 completed jobs' Handoff notes (see `jobs/00N-*.md`) or is scope PLAN.md names but no job has touched yet. Nothing here is speculative — each item traces back to a specific discovery, decision, or explicit deferral made while building. Where useful, a job file is cited as the primary source; read that file's Handoff notes for full context before starting.

This is a living backlog, not a job queue — pick items opportunistically rather than top-to-bottom. Update or remove entries as they're resolved.

---

## P0 — Real, user-visible bugs

- **Clock ± buttons don't affect pinned "machines"-mode nodes' real solved count.** `RecipeNode.tsx`'s `handleClockStep` still uses Job 010-era stopgap math (`recipeNodeMath.ts`) that treats "machines" mode as clock-dependent. But `packages/solver`'s real `pinnedMachineCount` (used by every actual solve since Job 017) returns the pinned `limit` **literally, with no clock term**, for a pinned `"machines"`-mode node — the default mode for every machine except Miner/AWESOME Sink. So clicking ± visibly moves the local stopgap number but has **zero effect on the real solved machine count** once a solve exists. Discovered and precisely diagnosed while building auto-round (Job 027), which added a guard for itself but explicitly left the pre-existing buttons broken. Fix: either disable/hide ± for a pinned machines-mode node, or rework `handleClockStep` to operate on `limit` instead of `clock` for that case. File: `apps/web/src/canvas/nodes/RecipeNode.tsx`.

- **Splurger-mediated edges never show red/orange port highlighting.** `computeValidity.ts`'s per-node edge lookup scans by the real `EdgeRecord.id`, but a Splurger-rewritten connection's solver-level id is a synthetic `sp:<a>><b>` composite that never matches. The underlying numbers are correct (verified live); only the validity decoration is missing. Fix (per Job 024's own suggestion): have `buildSnapshot.ts`/`splurgerPassthrough.ts` expose a `realEdgeId -> syntheticEdgeId[]` map for `computeValidity.ts`/`RecipeNode.tsx` to consult. Files: `apps/web/src/workers/splurgerPassthrough.ts`, `apps/web/src/canvas/nodes/computeValidity.ts`.

- **Injecting a very large document (~12,000 nodes) into the currently-viewed container hangs the browser tab.** Reproduced live during Job 024's cancellation testing — React Flow attempting to render that many nodes at once in one container freezes the tab for minutes. The solver/worker itself handles graphs this size fine in isolation (a 6000-node synthetic snapshot solved and cancelled correctly); this is purely a React DOM rendering cost. No virtualization exists for the canvas's node rendering. Worth a load-testing pass and, if real factories approach this scale, some form of viewport-based node virtualization.

- **Version restore doesn't propagate to an already-loaded Hocuspocus `Document` while collaborators are live-connected.** `onLoadDocument` only runs once per document *load*, not once per *connection* — if any connection is still open when a REST-triggered version restore happens, the in-memory `Document` on `apps/realtime` won't reflect the restored content until every connection closes and it naturally unloads. Flagged by Job 020, never fixed. Likely fix: have the restore route call the same internal-webhook mechanism Job 020 built for membership-change revocation, to force the affected document to reload/reconnect. Files: `apps/api/src/projects/docRoutes.ts` (restore route), `apps/realtime/src/server.ts`.

## P1 — Significant, documented gaps

- **No real deep-linking / URL routing.** `apps/web` still has no router library — project navigation is plain React state (`App.tsx`'s `View` union), with only a cosmetic `pushState` to `/p/:shortId/edit` that doesn't survive a reload (it boots back to the project list). A real fix needs both a router (or continued hand-rolled routing) and a `GET /api/projects/by-short-id/:shortId`-shaped endpoint that doesn't exist yet. Flagged since Job 008, never addressed.

- **`apps/web` has no DOM/component test infrastructure.** Every canvas job since 008 has verified UI behavior via live Browser-MCP sessions instead of automated component tests, because Vitest here is still node-environment-only (no jsdom/React Testing Library). This is a standing gap across the whole `apps/web` codebase — several genuinely subtle bugs (StrictMode double-effects, selection-loss-on-resync, focus-trap regressions) were only caught by live manual testing, not by any test suite. Adding RTL + a jsdom environment would let the highest-value hooks (`useProjectDocument`'s hydration ordering, `useYjsSync`, `useSolver`) get real regression coverage.

- **Priority-tier representation is a single, direction-agnostic bit per edge.** `SolverEdge.priorityTier` (Job 023) is used identically whether an edge is one of its `fromNode`'s splitter outputs or its `toNode`'s merger inputs. Fine for the common case (a Splurger acting as *either* a splitter or a merger, never both at once), but can't express a case where the same edge needs independent split-side/merge-side priority. Extending to two fields (`splitterTier`/`mergerTier`) is backward-compatible if this turns out to matter. File: `packages/solver/src/snapshot.ts`.

- **Splitter/merger cap bound isn't always tightest when two priority/capacity points sit directly adjacent on the same part.** The current per-group allocation (Job 023) uses each sibling edge's *other endpoint's total resolved rate* as its cap — always correct (never over-allocates), but not always the tightest possible bound when two splitter/merger points touch directly. Not exercised by any current benchmark; would need a graph-wide joint LP to fully close.

- **Splurgers**: a Splurger wired with both multiple inputs *and* multiple outputs simultaneously is detected and excluded (with a visible warning), not modeled — this mirrors real Satisfactory hardware (no single splitter/merger combines both), so it's arguably correct-by-design, but worth a second look if usage patterns want it. **Chained Splurgers** (one feeding directly into another with no real recipe node between them) are also not resolved — the pass-through rewrite only looks one hop away. Files: `apps/web/src/workers/splurgerPassthrough.ts`.

- **Nested blueprints are detected and skipped, not collapsed.** A blueprint inside a blueprint (any depth) falls through to ordinary outpost behavior rather than getting the joint-solve treatment. Job 026's own handoff notes say the mechanism should generalize with a bottom-up recursive collapse pass and needs no further `packages/solver` changes — just not attempted or tested. File: `apps/web/src/workers/blueprintCollapse.ts`.

- **Blueprint one-copy sub-solve runs synchronously on the main thread**, not inside Job 018's Web Worker — a deliberate, bounded deviation (justified since `@scm/gamedata` is already loaded on the main thread elsewhere). Worth moving into the worker if blueprint sizes grow well beyond PLAN.md's "tens to low hundreds" scale.

- **Cooperative cancellation for Full-mode solves doesn't actually interrupt an in-flight `solve()` call.** `Worker.terminate()` (Job 018) is doing 100% of the real cancellation work; the `CancelMessage`/`signal.aborted` path Job 023/024 wired end-to-end is inert in practice because a single-threaded synchronous worker can't check a flag mid-computation. Making it genuinely effective needs either a `SharedArrayBuffer`+`Atomics`-backed signal (needs COOP/COEP headers) or restructuring `packages/solver`'s Full-mode loop to yield periodically. Files: `apps/web/src/workers/solveScheduler.ts`, `packages/solver/src/full.ts`.

- **Viewer-role users have no client-side read-only canvas UI.** The server genuinely rejects a viewer's writes (Job 020, verified), but nothing on the client disables inputs/drag for a viewer — their local edits silently fail to persist with no in-canvas signal beyond the connection-status/save-status indicators. Worth building real disabled/read-only styling for viewer sessions.

- **i18n coverage is partial.** Job 028 gave a full pass to the highest-traffic surfaces (project list, canvas toolbar, Recipe Chooser, recipe node card, summary panel, settings, all three status indicators) but explicitly left these untouched, highest-volume first: `SharingPanel.tsx` (largest, ~25+ literals), `VersionPanel.tsx` (~20), `SplurgerNode.tsx` (~15), `InviteRedeemPage.tsx` (~15), `BlueprintNode.tsx` (~14), `OutpostNode.tsx` (~10), `NodeContextMenu.tsx` (~10), `Breadcrumbs.tsx`, `PresenceAvatarList.tsx`, `ConnectionEdge.tsx`, `BoundaryEdge.tsx`, `FieldPresenceRing.tsx`.

- **Locale-aware number formatting isn't wired.** `@scm/rational`'s decimal formatter always uses `.` as the separator regardless of active UI locale — PLAN.md's "per-location number formatting" turned out (on inspection of all 55 translation files) to mean per-*field* location, not per-language locale, so there's genuinely nothing in the string table to drive this. If locale-aware digit grouping/separators ever become a real requirement, it needs `Intl.NumberFormat(locale)` driven off `useLocale()`, independent of the translation tables.

## P2 — Smaller polish / known cosmetic gaps

- Auto-round's black-field-background signal is hard to distinguish by eye in dark theme (the normal dark-theme input background is already close to true black) — a real, computed-style-confirmed difference, just low visual contrast. Consider a theme-aware "strong signal" color instead of literal black, if faithfulness to PLAN.md's exact wording isn't required.
- The orange "mismatched" highlight color is close in hue to the outpost-amber accent — could read as visually ambiguous on a factory with both outposts and validity issues on screen at once. Worth a dedicated color pass.
- `SummaryPanel`'s focus trap lands initial focus on "Pop out" rather than the first scope tab (Everything/Current Outpost/Selected) — a minor keyboard-nav nicety, not a broken state.
- Marquee-selection's pre-first-paint fallback node size (`useMarqueeSelection.ts`'s `FALLBACK_SIZE_BY_TYPE`) needs manual updates whenever a node card's width class changes — no test currently guards this staying in sync.
- `apps/web/src/a11y/contrastAudit.ts`'s token values are a hand-kept duplicate of `index.css`'s real custom properties (no CSS-var-to-TS bridge exists) — a color token change that isn't mirrored here makes the contrast regression test silently stop proving anything real.
- `infra/Dockerfile`'s runtime image copies the entire built workspace uncurated (not size-optimized) — a legitimate future trim, not a correctness issue.
- `infra/fly.toml` was written against Fly.io's documented schema but never validated against a real account (`fly config validate` / a real `fly launch`) — first real deploy attempt should treat it as "written correctly," not "proven correct."
- No automated test exists for `useProjectDocument.ts`'s hydration-ordering invariant (push-listener/root-container-creation ordering) — guarded only by a code comment across Jobs 015/016/020. Worth a real regression test once `apps/web` gets DOM test infra (see P1).
- The dev Postgres has accumulated several thousand leftover test-fixture rows from the test suites across the whole 29-job history. Run `pnpm db:reset` (with the correct `DATABASE_URL`) before treating the current DB as a clean baseline for anything.

## Not yet built (explicit PLAN.md scope, no job has touched)

These are named in `PLAN.md` §3's "Later phases" / §10's "Open Questions" and were never in any of the 29 jobs' scope:

- **Additional specialty node types**: AWESOME Sink (with belt-tier cap), Storage Container (four fill modes), Dimensional Depot Uploader, Space Elevator phases, Any Part wildcard node. `SolverSnapshot` currently only represents plain recipe nodes and Splurgers — any of these needs both a `@scm/ydoc`/canvas-side node type (following `SplurgerNode.tsx`'s established pattern) and a solver-side representation strategy (following the "erase before the snapshot reaches `packages/solver`" pattern Jobs 024/026 established, if avoiding further solver core changes is desired). `SolveSummary.sinkPoints` is hardcoded to `"0"` specifically because AWESOME Sink doesn't exist yet.
- **Comments/annotations on nodes** — no schema, no UI.
- **Custom node colors/styles** — `NodeRecord.color`/`Container.color` already exist in the CRDT schema (Job 007) but nothing lets a user actually set them.
- **Tier-gated recipe filtering by save progression** — the Recipe Chooser has a tier filter, but nothing gates it against an actual save file's progression (would require save-file import, which is explicitly out of scope per PLAN.md).
- **`.sfmd` import/export** — PLAN.md's Open Question #4; the format is undocumented/closed, would need reverse-engineering from sample files before it's even feasible to scope.
- **Guest/anonymous access** — PLAN.md's Open Question #1; every account-touching job (005, 006, 020, 022) built strictly against real Discord-authenticated users.
- **Game-data version migration** — `projects.game_data_version` is stored (Job 004) but there's no migration/upgrade flow for when `game_data.json` changes across a Satisfactory patch (PLAN.md's Open Question #5).
- **Attribution footer** — PLAN.md's Open Question #7 ("not affiliated with Coffee Stain Studios" style line); never added.
- **Public project gallery / search** — the entire reason `proj_nodes`/`proj_edges` (Job 025) exists, but nothing queries those tables yet. This is the natural next consumer of that projection work.
- **The remaining summary-panel scope operations** — only Everything / Current Outpost / Selected are built (Job 019); PLAN.md's fuller list (`Current Outpost & Below`, `Selected & Below`, `Selected + Connected`) was explicitly left as a later refinement.
- **A third "unresolved" visual state** — Basic mode's "no limit, no resolvable neighbor, defaulted to 1 machine" case (`resolved: false`) currently gets no highlight at all (not red, not orange) — PLAN.md doesn't call for a third color, but it's a real, currently-invisible-to-the-user state worth considering.

## Production launch checklist (from Job 029)

The app is **deploy-ready, not deployed**. No real cloud account, production Discord app, Sentry project, or live backup exists — Job 029 deliberately stopped short of any of that (account creation and billing are the user's own action, not an agent's). Concretely, to go live:

1. Create a Fly.io account (or adapt `infra/fly.toml` for Railway/Render — PLAN.md leaves the host choice open, Fly.io is what was written).
2. Register a **production** Discord OAuth application (the existing `infra/.env` credentials are dev-only, pointed at `localhost:5173`) and set its redirect URI to the real production domain.
3. Provision a managed Postgres instance for production (not the local `docker-compose` one).
4. Set the ~6 categories of secrets Fly needs via `fly secrets set` — see `README.md`'s "Production deploy" section for the exact list (Discord client id/secret/redirect, cookie secret, database URL, realtime ticket/internal secrets, optionally `SENTRY_DSN`/`VITE_SENTRY_DSN`).
5. Optionally create a Sentry project and set its DSN — error reporting is already wired end-to-end (including the CRDT integrity-reducer-firing signal) and no-ops cleanly without one.
6. Set up the managed host's native backup feature, or schedule `infra/scripts/backup.sh` (a working `pg_dump`-based fallback, verified via a real dump/restore round trip) if the host has none.
7. `fly deploy` — `infra/Dockerfile` is built and verified locally (real HTTP + WebSocket traffic through the reverse proxy, graceful shutdown, self-healing teardown) but has never been run against a real Fly account.

---

*Compiled from Jobs 001-029's Handoff notes. See `jobs/INDEX.md` for the full build history and `jobs/0NN-*.md` for the complete reasoning behind any item above.*
