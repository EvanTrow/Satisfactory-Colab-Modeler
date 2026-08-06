# Job 013: Outposts (nested containers)

**Phase:** 2 · Solo canvas editor
**Status:** Not started
**Depends on:** 012 (selection & editing)

## Context

Read [`PLAN.md`](../PLAN.md) section **2. The Interaction Model to Reproduce** ("Outposts" row) and **3. Feature Scope → MVP → Structure** ("outposts with drill-in navigation and breadcrumbs; port mapping on the outpost node at the parent level"). Also re-read §10.3 (open question on blueprint semantics) for awareness — **blueprints themselves are out of scope** (Phase 7, Job 026), but this job's container model must not preclude that later work, since `containers` already has a `kind: 'outpost'|'blueprint'` field from Job 007.

## Scope

In scope:
- Outpost creation (e.g. via the Recipe Chooser's canvas context menu, or a dedicated "New Outpost" action — use judgement on exact entry point, consistent with PLAN.md's "like folders" framing) creating a `containers` entry via `packages/ydoc`.
- Drill-in navigation: double-clicking (or an explicit "open" affordance on) an outpost node switches the canvas view to render that container's contents instead of the parent's, with a **breadcrumb trail** back to root showing the container hierarchy.
- From outside (i.e. viewed from the parent container), an outpost renders as a **single node with input/output ports** — the port set is derived from which parts cross the outpost's boundary (edges whose `fromNode`/`toNode` live inside the outpost but connect to something outside). This is "port mapping" per PLAN.md §3 — implement it as a computed/derived view, not stored redundantly, so it can never drift from the actual internal edges.
- Moving a node into/out of an outpost (e.g. drag onto the outpost node, or a context-menu "move to container" action) updates its `containerId`.
- Deleting an outpost: per PLAN.md §5's integrity-reducer principle ("reparent orphaned nodes to the root container rather than deleting them"), deleting an outpost container must reparent its child nodes/edges to the container's parent rather than destroying them — implement this locally now (the full multiplayer-safe integrity reducer is Job 022, but the single-player deletion behavior should already follow this rule so it doesn't change later).

Out of scope:
- Blueprints (duplicable outposts) — Job 026.
- The formal cross-client integrity reducer pass (Job 022) — this job only needs correct behavior for a single local user's actions, not concurrent-edit repair.
- Any solver awareness of outpost boundaries (partitioning solve into per-outpost components is Job 018's "dirty-subgraph solving").

## Deliverables

- Outpost container creation + drill-in view switching + breadcrumb UI.
- Derived port-mapping logic (outpost node ports = boundary-crossing edges, computed not stored).
- Move-node-into/out-of-outpost interaction.
- Outpost deletion with reparent-to-parent behavior (not destroy).
- Tests: port mapping stays correct as internal edges change; deleting an outpost with children reparents them correctly; breadcrumb trail reflects actual nesting depth.

## Acceptance criteria

- Creating an outpost, adding nodes inside it, and connecting one of them to something outside correctly shows the outpost, from the parent view, with a port for that connection.
- Drilling in and back out via breadcrumbs correctly restores the parent view with all prior state intact.
- Deleting a populated outpost leaves its former children visible (reparented to the outpost's parent container), never silently destroyed.
- `pnpm --filter web test/build/typecheck` pass.

## Notes for the worker

- Keep port mapping derived/computed, not stored — PLAN.md is explicit elsewhere (§4 point 3, re: solver output) about the general principle of not syncing/storing what can be recomputed; the same logic applies here to avoid drift.
- When done, update this file's Status line and the row in [`INDEX.md`](../jobs/INDEX.md).
