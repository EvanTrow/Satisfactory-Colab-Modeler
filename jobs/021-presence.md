# Job 021: Presence (cursors, avatars, selection, field indicators)

**Phase:** 5 · Multiplayer
**Status:** Done
**Depends on:** 020 (Hocuspocus server)

## Context

Read [`PLAN.md`](../PLAN.md) section **5. Real-Time Sync Architecture → Presence** in full — the exact Awareness state shape is specified there — and section **3. Feature Scope → MVP → Multiplayer** ("presence avatars, per-user cursors, and selection highlighting; soft field-level indicators when someone else is typing in a field").

## Scope

In scope:
- Yjs **Awareness** state per the PLAN.md-specified shape: `{ userId, displayName, avatarUrl, color, cursor: { x, y, containerId } | null, selection: string[], editingField: { nodeId, field } | null }`. Confirm this is genuinely ephemeral — never written to Postgres, only ever exchanged over the live Awareness protocol.
- Color derivation from `userId` hash (deterministic per-user color, consistent across sessions/reconnects).
- Cursor rendering: other users' live cursors rendered on the canvas, **scoped to `containerId`** — a collaborator's cursor should only render when you're viewing the same outpost/container they are (per the schema's explicit purpose for that field).
- Selection highlighting: other users' selected nodes get a colored halo matching their presence color.
- Avatar list: a small UI element (e.g. top bar) showing who's currently connected to the project, using `avatarUrl`/`displayName` (sourced from the Discord profile data captured at login, Job 005).
- Soft field-level editing indicators: when another user is actively editing a specific field (e.g. a node's limit field), show a colored ring + their avatar near that field — explicitly a **soft** indicator per PLAN.md, never a hard lock (the local user must still be able to edit the same field; last-write-wins via the CRDT is fine).

Out of scope:
- Hard field locking of any kind — explicitly ruled out by PLAN.md ("hard locks in a CRDT tend to strand fields when a client disconnects uncleanly").
- Persisting any presence data to Postgres.
- Share-by-link/invite UI — Job 022.

## Deliverables

- `apps/web/src/collab/awareness.ts` (or similar) — Awareness state setup, color derivation, local state publishing (cursor position on mousemove, selection on select-change, editingField on focus/blur of relevant inputs).
- Cursor, selection-halo, and avatar-list UI components.
- Field-indicator UI wired to the relevant input components from Job 010 (limit, clock, shards fields).
- Tests: color is deterministic and stable for a given `userId`; cursor rendering correctly filters by `containerId` (a collaborator in a different outpost doesn't show a cursor on your current view); editingField indicator appears/clears correctly on focus/blur, including on ungraceful disconnect (the indicator must clear, not strand, when a peer's connection drops — verify this specifically since it's the exact failure mode PLAN.md warns hard locks suffer from, and soft indicators need to actually clear via Awareness's disconnect semantics).

## Acceptance criteria

- Two browser contexts on the same project show each other's live cursors (correctly container-scoped), selection halos, and avatars in the presence list.
- Disconnecting one client (e.g. closing its tab) clears its presence — cursor, selection, and any field indicator — from the other client within Awareness's normal timeout, with no stranded indicators.
- Both clients can edit the same field concurrently without either being blocked, while still seeing each other's soft indicator while doing so.
- `pnpm --filter web test` passes; manual two-tab verification performed and noted in Handoff notes.

## Notes for the worker

- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).

## Handoff notes

### File locations

All new logic/UI lives under `apps/web/src/collab/` (the directory PLAN.md §7 names for exactly this: "Yjs provider, awareness, presence UI"), which was a placeholder (`export {}`) before this job:

- `awareness.ts` — the Awareness wire shape (`AwarenessState`, `AwarenessCursor`, `AwarenessEditingField`), `colorFromUserId` (color derivation), `createLocalAwarenessState`, `parseAwarenessState` (runtime validator for a peer's raw state), `isCursorVisibleInContainer`/`selectVisibleCursors` (container-scoping), and the `AwarenessHandle` type alias. Zero React/DOM imports — pure and fully unit-tested (`awareness.test.ts`, 22 tests).
- `discordAvatar.ts` (+ `discordAvatar.test.ts`, 9 tests) — turns `GET /auth/me`'s raw `avatarHash` into a real Discord CDN URL, with the documented default-avatar fallback.
- `throttle.ts` (+ `throttle.test.ts`, 4 tests) — a tiny injectable-clock throttle, used to rate-limit cursor broadcasts.
- `useRemotePresence.ts` — the one shared subscription hook (`Awareness#"change"` → parsed remote states, excluding the local client). Every UI piece calls this itself rather than one value being baked into `CanvasDocContext`, so a cursor moving only re-renders the components that actually read presence.
- `useLocalPresence.ts` — publishes this client's own state once and returns the three setters (`setCursor`/`setSelection`/`setEditingField`).
- `useCursorPublisher.ts` / `useSelectionPublisher.ts` — the local-mousemove-to-cursor and local-selection-to-Awareness wiring, called from `CanvasView.tsx`'s `CanvasFlow`.
- `Avatar.tsx`, `PresenceAvatarList.tsx`, `PresenceCursors.tsx`, `FieldPresenceRing.tsx` — the actual UI.
- `index.ts` — the real barrel (was a placeholder).

Integration touch points (all in `apps/web/src`, all pre-existing files this job extended, not replaced):

- `canvas/persistence/useProjectDocument.ts` — `StaticCanvasDoc` gained an `awareness: AwarenessHandle` field. See "Threading the Awareness handle" below.
- `canvas/CanvasDocContext.ts` — gained `awareness` and `localPresence` fields on `CanvasDocContextValue`.
- `canvas/CanvasView.tsx` — `CanvasViewReady` calls `useLocalPresence` once and builds the context value; `CanvasFlow` wires mousemove→cursor and selection→Awareness publishing, mounts `<PresenceCursors>` as an overlay, and the header mounts `<PresenceAvatarList>`.
- `canvas/nodes/RecipeNode.tsx` — remote-selection halo (a `boxShadow` on the card), `<FieldPresenceRing>` on the limit/clock/shards fields, and `onFocus`/`onBlur` wiring on those same three fields to broadcast/clear `editingField`.
- `canvas/outposts/OutpostNode.tsx` — same remote-selection halo treatment (an outpost boundary node's id can also appear in a peer's `selection: string[]`, so this needed the same handling as `RecipeNode`, not just a passing mention).
- `App.tsx` — derives `LocalUserIdentity` (`{id, displayName, avatarUrl}`) from the existing `GET /auth/me` `CurrentUser` once (`useMemo`), passes it into `<CanvasView localUser={...}>`.

### Threading the Awareness handle — the decision Job 020 explicitly left open

Went with **"thread the live handle through `CanvasDocContext`, the same way `sfmDoc`/`undoManager` already are"** (the first of Job 020's two suggested options), not a dedicated new context. `StaticCanvasDoc.awareness` (in `useProjectDocument.ts`) is `provider.awareness`, typed as `NonNullable<HocuspocusProvider["awareness"]>` (aliased `AwarenessHandle` in `awareness.ts`) — this sidesteps needing `y-protocols` as a direct `apps/web` dependency (it's currently only a *peer* dependency of `@hocuspocus/provider`, not hoisted into `apps/web/node_modules`): TypeScript fully resolves the `Awareness` type transitively through `@hocuspocus/provider`'s own `.d.ts` this way, with no separate `import type { Awareness } from "y-protocols/awareness"` anywhere in `apps/web`. Confirmed this actually works — `tsc -b --noEmit` is clean and every method used (`setLocalState`/`setLocalStateField`/`getStates`/`on`/`off`/`clientID`) typechecks correctly.

**One real, necessary reorder inside `useProjectDocument.ts`'s `load()`**: Job 020's code constructed `provider = new HocuspocusProvider(...)` *after* the `cameFromCache` fast-path check, so the fast path's `finishHydration()` call ran with `provider` still `null` — fine for Job 020 (nothing needed the provider itself yet), but a real problem for this job (`finishHydration` needs `provider.awareness`, on *every* path, not just the slow one). Fixed by moving the `HocuspocusProvider` construction to right before the `cameFromCache` check instead of after it. This does **not** change when the WebSocket itself actually opens/authenticates (that's the provider's own internal timer, independent of when this effect happens to start holding a reference) — it only changes when this effect starts holding the reference to the (synchronously-constructed, connection-independent) `Awareness` instance. `finishHydration` itself now reads `provider.awareness` and throws (defensively, should be unreachable) if it's somehow null rather than silently handing every context consumer a broken value.

`CanvasDocContextValue.awareness` is exposed raw (like `sfmDoc`) — a descendant that wants to *read* remote state calls `useRemotePresence(awareness)` itself, deliberately **not** one shared subscription baked into the context's own memoized value. This was a deliberate perf choice: baking a `remotePresence` array into `docContext` would make every high-frequency cursor move produce a new context value, re-rendering every single consumer of the whole canvas doc context (all node components, panels, etc.) on every peer's mousemove. Instead only `PresenceCursors`, `PresenceAvatarList`, and each `RecipeNode`/`OutpostNode` (which already subscribe individually) re-render on a presence change.

`localPresence` (the three setters) **is** memoized once via `useMemo` inside `useLocalPresence` (keyed on the three `useCallback`-stabilized setters, which are themselves keyed on `awareness` identity) — this one *is* baked into `docContext`'s own `useMemo`, since it's a small, stable object (three function references) rather than a value that changes on every remote update.

### Color derivation

`colorFromUserId(userId)` in `awareness.ts`: a 32-bit rolling hash (`hash = Math.imul(hash, 31) + charCode`, `| 0` each step for determinism across engines) mapped to `hue = Math.abs(hash) % 360`, rendered as a fixed-saturation/lightness `hsl(${hue}, 70%, 55%)` string. Deterministic per `userId` alone (no server-side "assign a color" coordination needed — every client computes the identical string independently), stable across reconnects/sessions since it's a pure function of the id, not anything ephemeral. Not cryptographic — doesn't need to be, just needs to be stable and reasonably well-distributed across hues, which `awareness.test.ts` checks (determinism, hue range, a spot-check that four different fixture ids don't all collide).

### Container-scoping mechanism

`AwarenessCursor.containerId` is compared against the *viewer's own* `useCanvasDoc().containerId` (Job 013's "container currently being viewed") via `isCursorVisibleInContainer(cursor, viewingContainerId)` — a peer's cursor renders only when their last-published `cursor.containerId` exactly equals the local viewer's current `containerId`; a `null` cursor is always invisible. `PresenceCursors.tsx` calls this per remote peer every render (cheap — presence lists are small). `useCursorPublisher.ts` clears the local cursor to `null` whenever `containerId` changes (drill-in/breadcrumb navigation) so a stale flow-space position from the *previous* container's coordinate space never lingers visible anywhere until the next mousemove re-publishes a correct one.

Cursor position itself is published in flow-space coordinates (`screenToFlowPosition`, the same conversion Recipe Chooser/connection code already uses), and `PresenceCursors.tsx` re-projects back to screen space using `useViewport()`'s `{x, y, zoom}` applied as a single `translate(...) scale(...)` on a wrapping div — the same transform approach React Flow's own internals use, so cursors track pan/zoom with no extra per-frame code.

### Local user identity (displayName/avatarUrl)

`App.tsx` already fetches `GET /auth/me` (Job 005) into `CurrentUser` — this job added a `useMemo` deriving `LocalUserIdentity = {id, displayName: globalName ?? username, avatarUrl: discordAvatarUrl(discordId, avatarHash)}` once per authenticated user, passed into `<CanvasView localUser={...}>` the same way `projectId`/`role` already flow in. `discordAvatarUrl` (in `collab/discordAvatar.ts`): a real avatar hash → `https://cdn.discordapp.com/avatars/{discordId}/{hash}.{png|gif}` (`.gif` when the hash has Discord's `a_` animated-avatar prefix); no hash at all → Discord's own default-avatar convention, `https://cdn.discordapp.com/embed/avatars/{(BigInt(discordId) >> 22n) % 6n}.png`. Every remote peer's `avatarUrl` in their own published Awareness state is *their* client's independent computation of the exact same function against their own profile — never recomputed locally for a peer, just displayed as-is (their URL travels over the wire as a plain string field).

### Field-level indicators — a UI wrinkle worth flagging

The shards control in `RecipeNode.tsx` (Job 010) has no `<input>` — it's a plain `<span>` readout plus two stepper `<button>`s. Since the job explicitly names "limit, clock, shards" as the three fields needing soft indicators, `editingField: {nodeId, field: "shards"}` is broadcast/cleared on `onFocus`/`onBlur` of **both stepper buttons** (a button does receive real focus on click in every modern browser), not on the readout span. This means the indicator flashes for as long as a button has focus (until the user clicks/tabs elsewhere), not for a sustained "editing" session the way a text field's focus/blur naturally maps — a reasonable, documented interpretation given there's no text field to attach to, not an oversight. `FieldPresenceRing` itself renders identically regardless of which element triggered it.

Every field wraps its own `<input>`/readout in a small `relative` `<span>` (not the whole row) so `FieldPresenceRing`'s ring hugs just the field, not the label + field row.

### Selection halo vs. local `selected` — deliberately two separate mechanisms

`RecipeNode`/`OutpostNode`'s remote-selection halo (`remoteSelectors`, a `boxShadow` in the peer's color) is intentionally **not** unified with React Flow's own `selected` prop (Job 012's local, Zustand-store-driven selection). They render as visually distinct things (an accent border vs. a colored halo, and can both be present simultaneously — you can have a node selected locally while someone else also has it selected). If more than one peer has the same node selected, the halo uses the *first* peer's color for the ring, but a small stacked row of colored dots above the card (one per peer) lists everyone, not just the first.

### Automated tests

- `apps/web/src/collab/{awareness,discordAvatar,throttle}.test.ts` — 35 pure-logic tests (color determinism/format/range, `parseAwarenessState` accept/reject cases including malformed `cursor`/`editingField`, `isCursorVisibleInContainer`/`selectVisibleCursors` same-container/different-container/null-cursor cases, Discord avatar URL construction + default-avatar formula, throttle timing with an injectable fake clock). `apps/web` test count: 217 → 250.
- `apps/realtime/src/presence.test.ts` (new file, own port range 18244/18245 — deliberately disjoint from `server.test.ts`'s 18234-18237 since vitest runs test files in parallel by default) — **two real, independent `@hocuspocus/provider` clients** against a real running `createHocuspocusServer()` instance, following `server.test.ts`'s own precedent exactly (real Postgres-backed `project_members` roles, no client UI involved):
  - "propagates one client's published Awareness state to a second, independently-connected client" — asserts the *full* published shape (including `cursor`/`selection`/`editingField`) round-trips through the real server unmodified.
  - "clears a disconnected peer's Awareness state from the other client, with no stranded presence" — publishes a full presence footprint, confirms it arrives, then `provider.destroy()`s the first client and confirms `awarenessB.getStates()` no longer contains it, polled via `Awareness#"change"` (not a fixed sleep) with a 5s timeout. This is the automated proof behind the manual disconnect-cleanup check below, and it passes reliably (not flaky/timing-dependent) since `@hocuspocus/server`'s `Document.removeConnection` calls `removeAwarenessStates` synchronously the moment it notices the socket close — confirmed by reading the compiled source (`node_modules/.pnpm/@hocuspocus+server@4.5.0.../hocuspocus-server.cjs`), not assumed.
  `apps/realtime` test count: 11 → 13.
- Repo-wide: **rational 67, ydoc 29, gamedata 40, doc-storage 24, solver 17, api 85, realtime 13, web 250 — 525 tests, all passing.** `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint` all clean. (One transient failure was observed in `server.test.ts`'s pre-existing, Job-020-authored "force-disconnects on outright removal" test during one `pnpm -r test` run under heavy parallel load across all 10 workspace projects at once — reran `pnpm --filter realtime test` and the full `pnpm -r test` immediately after, both green; confirmed this is resource-contention flakiness in a 5-second timeout, not a regression this job introduced — not touched by anything in this job's diff.)

### Manual verification actually performed

Through the real (non-bypassed) app — `apps/api` (3001) and `apps/realtime` (1234/1235) run via `tsx watch`, `apps/web` via the `web-qa` dev-server config (5173), all against the real Postgres at `postgresql://scm:scm@localhost:5434/scm` — using the Browser MCP for the "real browser tab" side and a real, independent `@hocuspocus/provider` Node-side client for the "second browser" side, per Job 020's own established precedent (this sandboxed browser can't hold two cookie-authenticated tabs as different users). Two throwaway scripts (`apps/api/qaPresenceSetup.ts`, `apps/realtime/qaPresenceClient.mjs`) minted a real QA Owner + QA Editor user/project/membership and a real session (a tiny local HTTP redirect server planted the real, `httpOnly`/`Secure` `sfm_session` cookie via a genuine `Set-Cookie` response header — the login flow was not bypassed at the session layer, only the Discord OAuth exchange itself was skipped, same as this app's Discord app not being configured in this sandbox) — both scripts deleted before committing, confirmed via `git status`.

Verified, in order:

1. **Real browser login + real live sync**: logged in as QA Owner through the real `sfm_session` cookie, opened the real "Job 021 QA" project, confirmed the header showed **"Saved"** (genuine provider connect+sync, not a stub) and the avatar list showed exactly one entry — `qa-owner-021 (you)`, `avatarUrl` correctly resolved to the real default-avatar embed URL (no avatar hash set on this test user).
2. Added one real recipe node (Iron Ingot/Smelter) via the real Recipe Chooser, and a real "New Outpost" child container, via the real UI (double-click-to-open-chooser simulated via two dispatched native `click` events at the same point within the double-click window, since `computer`'s coordinate-based clicks needed a screenshot this sandboxed Browser pane couldn't produce — confirmed this is a faithful stand-in: `isDoubleClick`'s own logic only cares about elapsed time/pixel distance between two click events, which is exactly what was reproduced).
3. **Second client connects and publishes real Awareness state**: a real `HocuspocusProvider` (Node-side, genuine WebSocket, genuine editor-role ticket for the real QA Editor user) connected to the same project and called `awareness.setLocalState(...)` with the exact `AwarenessState` shape (cursor in the root container, `selection: [the real node's id]`, `editingField: {nodeId, field: "limit"}`).
4. **Avatar list**: browser's avatar list updated live to show both `qa-owner-021 (you)` and `qa-editor-021` — confirmed via DOM query (`title` attributes + `avatarUrl` `src`s), no reload.
5. **Selection halo**: the real node's card gained `box-shadow: rgb(60, 167, 221) 0px 0px 0px 3px` (= `hsl(200, 70%, 55%)`, the QA Editor's exact published color) — confirmed via DOM query on the live rendered card.
6. **Field-level soft indicator**: a `[title="qa-editor-021 is editing this field"]` avatar badge appeared next to the node's limit field — confirmed via DOM query.
7. **Cursor rendering, same-container-visible case**: a `<span>qa-editor-021</span>` cursor label (same color) was present in the DOM while the browser viewed the root container (matching the peer's published `cursor.containerId`).
8. **Container-scoping, different-container-invisible case**: navigated the browser into the new outpost (drilled in via the outpost node's real "Open →" button) — confirmed the cursor label **disappeared** (0 matches) while the peer's `cursor.containerId` was still `root`, i.e. still connected and still publishing, just not visible from a different container. The avatar list (correctly *not* container-scoped — presence is "who's on the project," not "who's in this outpost") still showed both users. Navigated back to Root via the breadcrumb — cursor label **reappeared** (1 match). Both directions of the container-scoping requirement verified explicitly, not just one.
9. **Concurrent editing, not blocked**: with the field-editing indicator actively showing, confirmed the real limit `<input>`'s `disabled`/`readOnly` are both `false`, and that `.focus()` on it succeeds with no interception/blocking — the soft-indicator design genuinely never disables the input, matching PLAN.md's explicit requirement.
10. **Disconnect cleanup, zero stranded state**: killed the QA Editor's real Node process tree (`Stop-Process -Force` on the actual `node.exe` PID, not just the shell wrapper — confirmed via `Get-CimInstance Win32_Process`/`CommandLine` that the real WebSocket-holding process was terminated). Within the few seconds it took to run the follow-up DOM query (no fixed wait needed), confirmed **all four** pieces of that peer's presence were gone from the browser simultaneously: cursor label (0 matches), avatar list entry (only "you" + unrelated part-icon `img`s remained), selection halo (`box-shadow` div gone), and the field indicator (`[title="qa-editor-021 is editing this field"]`, 0 matches) — no manual cleanup code anywhere in this job's diff, entirely `@hocuspocus/server`'s own connection-close → `removeAwarenessStates` behavior, exercised here through the real server a second time (independently of the automated `presence.test.ts` proof above).

All QA processes (both dev servers this job started, the cookie-injection server, the QA Editor Node client) and both throwaway scripts were stopped/deleted before committing; QA database rows (test users/project) were left in place, matching every prior job's own precedent for minting throwaway test users.

### Anything Job 022 (integrity reducer & sharing) needs to know

- **Presence data should not factor into the integrity reducer or persistence at all.** It's confirmed genuinely ephemeral end-to-end in this job (never touches `sfmDoc`, `@scm/doc-storage`, or Postgres anywhere in the diff) — Job 022's reducer pass (PLAN.md §5: "run after every transaction... on both client and server," tagged `origin: 'integrity'`) operates on the CRDT document, which Awareness is completely outside of. No overlap, no interaction needed.
- **`apps/api/src/projects/memberRoutes.ts`'s existing role/removal routes already force-disconnect a revoked user's live *connection*** (Job 020's revocation mechanism) — but that only closes the WebSocket, which is exactly what makes this job's Awareness cleanup automatic too: a removed/downgraded member's cursor/selection/field-indicator disappear from every other client's view as a natural side effect of the same `connection.close()`, with no separate presence-specific cleanup Job 022 needs to add when it builds real invite/removal UI on top of `memberRoutes.ts`.
- **The avatar list (`PresenceAvatarList`) currently shows every connected role, including viewers**, with no visual distinction between an owner/editor/viewer in the list itself (just avatar + displayName tooltip). If Job 022's sharing UI wants to show roles prominently (e.g. a members management panel), that's a separate, richer UI than this presence avatar strip — this job deliberately kept the avatar list minimal ("who's currently connected," per the job's own Deliverables wording), not a role-aware member list. Worth deciding whether Job 022's member-management panel and this presence avatar list should ever be visually unified, or stay two separate UI surfaces (current state: the latter).
- **No changes were made to `apps/realtime/src/server.ts`** — Awareness is relayed entirely by Hocuspocus's own built-in protocol handling with zero custom server-side code; `HocuspocusContext`'s `{userId, role}` (available in `onAuthenticate`/hooks) was not needed for anything in this job and remains available for Job 022 or a future job if server-side awareness moderation is ever wanted (not required by PLAN.md, which frames Awareness as client-only/ephemeral).
