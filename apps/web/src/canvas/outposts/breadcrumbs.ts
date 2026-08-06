// Job 013: the breadcrumb trail behind "drill in / drill out" navigation
// (PLAN.md §2's Outposts row — "Drill in to edit contents" — and §3's
// "outposts with drill-in navigation and breadcrumbs"). Pure function of an
// already-loaded `Container[]` snapshot, same discipline as the rest of
// `outposts/` — no Yjs access.
import type { Container } from "@scm/ydoc";

/**
 * Walks `containerId`'s `parentId` chain back to the root and returns the
 * path from root to `containerId` (inclusive), root first — exactly the
 * order a breadcrumb trail renders left to right ("Root › Outpost A ›
 * Outpost B"). Returns `[]` if `containerId` isn't found (defensive only —
 * shouldn't happen once a container exists, but guards against a stale id
 * surviving a concurrent delete).
 */
export function computeBreadcrumbPath(containerId: string, containers: readonly Container[]): Container[] {
  const byId = new Map(containers.map((container) => [container.id, container]));
  const path: Container[] = [];
  let current: Container | undefined = byId.get(containerId);
  // Cap iterations at the container count so a corrupt/cyclic parentId
  // chain (shouldn't happen — nothing in this app's UI can produce one —
  // but a concurrent-edit race is exactly the kind of thing Job 022's
  // integrity reducer exists for) can't spin this into an infinite loop.
  let guard = containers.length + 1;
  while (current && guard-- > 0) {
    path.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}
