// Outpost drill-in/out as real browser history entries — so the back/
// forward buttons (and mouse back/forward buttons, which fire the exact
// same `popstate` event) step through outpost navigation the same way they
// already step through entering/leaving a project (`App.tsx`'s own
// `enterCanvas`/`enterGuestCanvas`, manual History API pushes — this app has
// no router library, see that file's `View` comment).
//
// The scheme: each of the three canvas base URLs (`/p/:shortId/edit` for
// `mode="cloud"`, `/g/:id` for `mode="guest"`, `/pub/:shortId` for
// `mode="public"` — see `CanvasView.tsx`'s `CanvasViewReady` for how each
// mode's `basePath` is derived) gets an optional `/o/:containerId` suffix
// for "currently viewing this outpost, not the root." Root never appears in
// the suffix — a root view's URL is just the bare base path, matching what
// `enterCanvas`/`enterGuestCanvas` already push when a project is first
// opened, so no extra history entry is needed for the common case of never
// drilling into an outpost at all.
export function buildContainerPath(basePath: string, containerId: string, rootContainerId: string): string {
  return containerId === rootContainerId ? basePath : `${basePath}/o/${encodeURIComponent(containerId)}`;
}

/**
 * The inverse of `buildContainerPath` — `null` means `pathname` isn't under
 * `basePath` at all (this mode's canvas isn't even the thing on screen,
 * e.g. mid-transition to/from the project list). Deliberately doesn't
 * validate that the returned id is a real, still-existing container —
 * callers that can (`CanvasViewReady` has `sfmDoc` in hand) should check
 * that themselves and fall back to `rootContainerId`, same as a stale/
 * deleted-outpost bookmark or a hand-edited URL.
 */
export function parseContainerIdFromPath(
  basePath: string,
  pathname: string,
  rootContainerId: string,
): string | null {
  if (pathname === basePath) return rootContainerId;
  const prefix = `${basePath}/o/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}
