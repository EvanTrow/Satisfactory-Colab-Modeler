import { Rocket } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listProjects, type ProjectSummary } from "./api/projects";
import { CanvasView, GuestCanvasView } from "./canvas";
import { discordAvatarUrl, type LocalUserIdentity } from "./collab";
import { GuestModeExplainer, importGuestProjectsToAccount, type GuestProjectSummary } from "./guest";
import { LandingPage } from "./landing";
import { GuestProjectsPage } from "./routes/GuestProjectsPage";
import { ProjectsPage } from "./routes/ProjectsPage";
import { UserSettingsPage } from "./routes/UserSettingsPage";
import { InviteRedeemPage } from "./sharing";
import { ThemeToggle, useTheme } from "./theme";
import { ConfirmDialog, useConfirmDialog } from "./ui";

/**
 * Guest-mode work: whether this browser has opted into Limited Guest Mode —
 * `localStorage`, not React state alone, so a page refresh (or the app
 * simply reopening in a new tab) lands back in the guest project list
 * instead of bouncing to the landing page every time, matching the
 * always-local nature of guest data itself (`guest/localProjects.ts`).
 * Cleared only by `showGuestModeInfo`'s "exit guest mode" confirm below —
 * never automatically, since a real login (`auth.status === "authenticated"`)
 * already takes priority over this flag everywhere it's checked below
 * without needing to clear it.
 */
const GUEST_MODE_STORAGE_KEY = "scm_guest_mode_active";

/**
 * Job 022: share-by-link. This app has no router (see the `View` comment
 * below), so a `/i/:token` link is handled by plain `pathname` parsing on
 * mount, same spirit as `enterCanvas`'s own manual History API push.
 * `sessionStorage` carries the token across the one hop this flow
 * genuinely needs a redirect for: an anonymous visitor has to leave for
 * `/auth/discord/login` (which always lands back on `/`, per
 * `authRoutes.ts`'s fixed `postLoginRedirect` — there's no redirect-target
 * plumbing to preserve `/i/:token` through that round trip server-side), so
 * the token is stashed client-side immediately and picked back up once
 * `auth.status === "authenticated"` on the next mount, regardless of
 * whether that's this same page load or the one after login.
 */
const PENDING_INVITE_STORAGE_KEY = "scm_pending_invite_token";

function extractInviteTokenFromPath(pathname: string): string | null {
  const match = /^\/i\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function extractProjectShortIdFromPath(pathname: string): string | null {
  const match = /^\/p\/([^/]+)\/edit\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

// Minimal shape of GET /auth/me's response body (apps/api/src/auth/routes.ts).
interface CurrentUser {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
}

type AuthState = { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; user: CurrentUser };

/**
 * Which top-level view is showing once the user is authenticated. There's
 * still no router library in `apps/web` (none of the key libraries in
 * PLAN.md §7 name one, and nothing so far has needed real URL-based
 * routing) — this is plain React state, not URL-addressable via React
 * Router or similar.
 *
 * `enterCanvas` pushes a `/p/:shortId/edit` URL into the address bar (via
 * the History API directly) so the browser's address bar reflects what's
 * on screen and the back button works. It IS also a real deep link: on
 * mount, `App` checks the current pathname (see the
 * `extractProjectShortIdFromPath` effect below) and, once authenticated,
 * resolves the `shortId` back to a project via `listProjects` so a
 * hard refresh (or a bookmarked/shared `/p/:shortId/edit` URL) lands back
 * in the canvas instead of bouncing to the project list. There's no
 * dedicated `GET /api/projects/by-short-id/:id` endpoint for this — it
 * reuses the same `listProjects` call the project list itself already
 * makes, filtering client-side, same spirit as `handleInviteRedeemed`
 * below.
 */
type View =
  | { name: "projects" }
  | { name: "canvas"; project: ProjectSummary }
  // Account-level settings (`routes/UserSettingsPage.tsx`) — only reachable
  // from the project list's own header, not from inside a project (no
  // `CanvasView` entry point), so it always closes back to "projects". Has
  // its own `/settings` URL (see `openSettings`/`closeSettings` below), same
  // as `"canvas"` does — a fresh load or refresh on `/settings` lands here
  // directly rather than on the project list, and the browser back button
  // pops out of it instead of leaving the SPA (see the `popstate` handler).
  | { name: "settings" }
  // Guest-mode work: the local-storage siblings of "projects"/"canvas" —
  // see `guestMode` below for what gates rendering these.
  | { name: "guestProjects" }
  | { name: "guestCanvas"; project: GuestProjectSummary };

function App() {
  const { t } = useTranslation("app");
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // Lazy initializer: `/settings` is the one `View` that's resolvable from
  // the URL alone, with no auth/network round trip needed first (see the
  // `View` comment above) — everything else (`"canvas"`) needs the
  // `initialProjectShortId` effect below because it needs a project fetched
  // by shortId first.
  const [view, setView] = useState<View>(() => {
    if (window.location.pathname === "/settings") return { name: "settings" };
    // Guest-mode work: a page refresh (or a new tab) with the guest flag
    // already set from a previous visit lands back in the guest project
    // list, not the landing page — see `GUEST_MODE_STORAGE_KEY`'s own
    // comment above for why this is `localStorage`, not just this state.
    if (localStorage.getItem(GUEST_MODE_STORAGE_KEY) === "1") return { name: "guestProjects" };
    return { name: "projects" };
  });
  // Guest-mode work: mirrors `GUEST_MODE_STORAGE_KEY` into React state so
  // JSX below can react to it; every write to this also writes (or clears)
  // the `localStorage` key in the same call — see `enterGuestMode`/
  // `showGuestModeInfo` below, the only two places this is ever set.
  const [guestMode, setGuestMode] = useState<boolean>(
    () => localStorage.getItem(GUEST_MODE_STORAGE_KEY) === "1",
  );
  // Guest-mode work: "sign in from guest mode and your local projects get
  // added to your account" — see the two effects below and
  // `guest/importGuestProjects.ts`. `guestImportBusy` gates rendering
  // `<ProjectsPage>` (see its own render-site comment) so that page's own
  // `listProjects()` fetch — which runs once on ITS mount, with no way for
  // this component to trigger a refetch afterward — never runs before the
  // newly-imported projects actually exist server-side. `guestImportNotice`
  // is a plain string (not boolean), same "only set when there's actually
  // something to say" shape `ProjectsPage.tsx`'s own `notice` state uses.
  const [guestImportBusy, setGuestImportBusy] = useState(false);
  const [guestImportNotice, setGuestImportNotice] = useState<string | null>(null);
  // Guards against running the import twice for the same "just
  // authenticated while guestMode was on" transition — most importantly
  // React StrictMode's dev-only double-invoke of effects, which would
  // otherwise race two full import passes against the same guest projects.
  // Deliberately NOT reset to `false` on every render: only the "some
  // guest projects failed to import" branch inside the effect resets it,
  // so a later reload while still signed in gets to retry those, but a
  // transient re-render of this same mount never re-triggers it.
  const guestImportAttemptedRef = useRef(false);
  const { requestConfirm, dialogProps: confirmDialogProps } = useConfirmDialog();
  // Job 014: mounted once here (not just inside `CanvasView.tsx`) precisely
  // because "app-level, not canvas-only" is the whole point — see
  // `theme/useTheme.ts`'s header comment. Both mounts share the same
  // localStorage-backed state; only one of the two views is ever on screen
  // at once, so there's no risk of them fighting each other.
  const { theme, toggleTheme } = useTheme();

  // Job 021: this client's own identity, for publishing local Awareness
  // presence (`collab/useLocalPresence.ts`) — derived once per authenticated
  // user (not recomputed every render) so `CanvasView`'s `localUser` prop
  // stays referentially stable across unrelated `App` re-renders.
  // `discordAvatarUrl` turns `avatarHash` (a raw Discord CDN hash, not a
  // usable URL on its own) into the real image URL — see that module's
  // header comment for the exact CDN convention, including the "no custom
  // avatar set" fallback.
  const localUser: LocalUserIdentity | null = useMemo(() => {
    if (auth.status !== "authenticated") return null;
    const { user } = auth;
    return {
      id: user.id,
      displayName: user.globalName ?? user.username,
      avatarUrl: discordAvatarUrl(user.discordId, user.avatarHash),
    };
  }, [auth]);

  const enterCanvas = useCallback((project: ProjectSummary) => {
    setView({ name: "canvas", project });
    window.history.pushState({ shortId: project.shortId }, "", `/p/${project.shortId}/edit`);
  }, []);

  /**
   * Guest-mode work: shown before Limited Guest Mode is actually entered
   * (the "what you're choosing" explainer, `GuestModeExplainer.tsx`) — and
   * reused as-is by `showGuestModeInfo` below for the header badge's
   * "already in guest mode, want to leave?" case, just with a different
   * `confirmLabel`/`danger`. One dialog, two call sites, since the content
   * a guest needs to see is identical either way.
   */
  const enterGuestMode = useCallback(async () => {
    const confirmed = await requestConfirm({
      title: t("guestMode.explainerTitle"),
      message: <GuestModeExplainer />,
      // A `Rocket` icon prefix, not plain text — matches Ferrumium's own
      // "Continue as Guest" button (see this file's `GuestModeExplainer`
      // import comment). `confirmLabel` accepts `ReactNode` for exactly
      // this (`ui/useConfirmDialog.ts`'s own doc comment); every other call
      // site (delete/revoke/remove, and `showGuestModeInfo` below) still
      // just passes plain text.
      confirmLabel: (
        <span className="inline-flex items-center gap-1.5">
          <Rocket aria-hidden className="h-3.5 w-3.5" />
          {t("guestMode.continueButton")}
        </span>
      ),
    });
    if (!confirmed) return;
    localStorage.setItem(GUEST_MODE_STORAGE_KEY, "1");
    setGuestMode(true);
    setView({ name: "guestProjects" });
  }, [requestConfirm, t]);

  /** The header's Guest Mode badge — reopens the same explainer, this time offering to exit instead of to enter. */
  const showGuestModeInfo = useCallback(async () => {
    const confirmed = await requestConfirm({
      title: t("guestMode.explainerTitle"),
      message: <GuestModeExplainer />,
      confirmLabel: t("guestMode.confirmExitButton"),
      danger: true,
    });
    if (!confirmed) return;
    localStorage.removeItem(GUEST_MODE_STORAGE_KEY);
    setGuestMode(false);
    setView({ name: "projects" });
    window.history.pushState({}, "", "/");
  }, [requestConfirm, t]);

  const enterGuestCanvas = useCallback((project: GuestProjectSummary) => {
    setView({ name: "guestCanvas", project });
    window.history.pushState({}, "", `/g/${project.id}`);
  }, []);

  const leaveGuestCanvas = useCallback(() => {
    setView({ name: "guestProjects" });
    window.history.pushState({}, "", "/");
  }, []);

  // Deep-link resolution: if the page loaded (or was refreshed) on
  // `/p/:shortId/edit`, recover which project that is once we know who's
  // logged in, and jump straight into its canvas — see the `View` comment
  // above. Captured once at mount via a lazy initializer (not an effect)
  // since `window.location.pathname` won't change under us before this
  // runs; `enterCanvas` itself keeps the URL in sync from here on.
  const [initialProjectShortId] = useState<string | null>(() =>
    extractProjectShortIdFromPath(window.location.pathname),
  );
  const [resolvingProjectLink, setResolvingProjectLink] = useState(initialProjectShortId !== null);

  useEffect(() => {
    if (!initialProjectShortId || auth.status === "loading") return;
    if (auth.status !== "authenticated") {
      // Anonymous on a deep link: the login prompt below takes over, same
      // as any other authenticated-only route. There's no redirect-target
      // plumbing through `/auth/discord/login` (see the `/i/:token` header
      // comment above) to pick this back up post-login.
      setResolvingProjectLink(false);
      return;
    }

    let cancelled = false;
    listProjects()
      .then((projects) => {
        if (cancelled) return;
        const match = projects.find((p) => p.shortId === initialProjectShortId);
        if (match) {
          setView({ name: "canvas", project: match });
        } else {
          // Deleted, never existed, or the user lost access: fall back to
          // the project list and drop the stale URL rather than getting
          // stuck re-resolving it.
          window.history.replaceState({}, "", "/");
        }
      })
      .catch(() => {
        if (!cancelled) window.history.replaceState({}, "", "/");
      })
      .finally(() => {
        if (!cancelled) setResolvingProjectLink(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialProjectShortId, auth.status]);

  const leaveCanvas = useCallback(() => {
    setView({ name: "projects" });
    window.history.pushState({}, "", "/");
  }, []);

  const openSettings = useCallback(() => {
    setView({ name: "settings" });
    window.history.pushState({}, "", "/settings");
  }, []);

  const closeSettings = useCallback(() => {
    setView(guestMode ? { name: "guestProjects" } : { name: "projects" });
    window.history.pushState({}, "", "/");
  }, [guestMode]);

  // Browser back button while the canvas or settings is open: pop out to
  // the project list instead of leaving the SPA (there's nowhere else for
  // this History entry to go, since neither `enterCanvas` nor
  // `openSettings` ever pushes more than one level). Guest-mode work: pops
  // out to the guest project list instead when this browser is in guest
  // mode, mirroring every other list-view fallback in this file.
  useEffect(() => {
    function onPopState() {
      setView((current) => {
        if (current.name === "projects" || current.name === "guestProjects") return current;
        return guestMode ? { name: "guestProjects" } : { name: "projects" };
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((user: CurrentUser | null) => {
        if (cancelled) return;
        setAuth(user ? { status: "authenticated", user } : { status: "anonymous" });
      })
      .catch(() => {
        if (!cancelled) setAuth({ status: "anonymous" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Guest-mode work: a guest who was looking at the guest project list and
  // clicked the header's "Log in with Discord" link leaves the SPA
  // entirely for the OAuth round trip, then lands back on `/` — a fresh
  // mount, where the `view` lazy initializer above still reads the (still
  // untouched-by-login) guest-mode `localStorage` flag and starts this
  // mount right back on `"guestProjects"`. Nothing below renders that view
  // once `auth.status` is `"authenticated"` (see the guest project-list
  // render guard's own comment), so without this, a freshly-logged-in
  // former guest would see a blank content area. This is the general fix
  // (not folded into the import effect below) since it has to apply even
  // when there's nothing to import (e.g. an empty guest project list).
  useEffect(() => {
    if (auth.status === "authenticated" && view.name === "guestProjects") {
      setView({ name: "projects" });
      window.history.replaceState({}, "", "/");
    }
  }, [auth.status, view.name]);

  // Guest-mode work: the actual "add my guest projects to my account" step
  // — see `guestImportBusy`/`guestImportNotice`/`guestImportAttemptedRef`'s
  // own comments above and `guest/importGuestProjects.ts` for the per-
  // project import itself. Fires once per "just became authenticated while
  // the guest-mode flag is still set" transition, regardless of which view
  // is currently showing (the effect above already gets `view` out of
  // `"guestProjects"`'s way in parallel) — "even if they have an account
  // with projects already, add these too" per this feature's own
  // requirement, so this never checks whether the account is empty first.
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (localStorage.getItem(GUEST_MODE_STORAGE_KEY) !== "1") return;
    if (guestImportAttemptedRef.current) return;
    guestImportAttemptedRef.current = true;

    setGuestImportBusy(true);
    importGuestProjectsToAccount()
      .then((summary) => {
        if (summary.failed === 0) {
          // Everything local is now safely in the account — the guest-mode
          // flag (and the "Guest Mode" badge it drove) has nothing left to
          // mean. `summary.imported === 0` (an empty guest project list)
          // also lands here and clears it just the same.
          localStorage.removeItem(GUEST_MODE_STORAGE_KEY);
          setGuestMode(false);
        } else {
          // At least one guest project is still sitting in this browser,
          // un-imported — leave the flag set and allow a future mount
          // (e.g. the next page load while still signed in) to retry it,
          // rather than silently giving up on it.
          guestImportAttemptedRef.current = false;
        }
        if (summary.imported > 0) {
          setGuestImportNotice(t("guestMode.importNotice", { count: summary.imported }));
        }
      })
      .catch((err: unknown) => {
        console.error("[App] guest project import failed", err);
        guestImportAttemptedRef.current = false;
      })
      .finally(() => setGuestImportBusy(false));
  }, [auth.status, t]);

  // Job 022: `/i/:token` detection — see this file's header comment. Runs
  // once on mount: if the URL itself carries a token, stash it and replace
  // the URL with `/` (so the rest of `App`'s pathname-free view logic is
  // undisturbed); either way, pick up whatever's in `sessionStorage` (set
  // either just now, or by a *previous* mount right before the Discord
  // login redirect).
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  useEffect(() => {
    const fromUrl = extractInviteTokenFromPath(window.location.pathname);
    if (fromUrl) {
      sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, fromUrl);
      window.history.replaceState({}, "", "/");
    }
    const stored = sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    if (stored) setPendingInviteToken(stored);
  }, []);

  const dismissPendingInvite = useCallback(() => {
    sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
    setPendingInviteToken(null);
  }, []);

  const handleInviteRedeemed = useCallback(
    (projectId: string) => {
      sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
      setPendingInviteToken(null);
      listProjects()
        .then((projects) => {
          const joined = projects.find((p) => p.id === projectId);
          if (joined) enterCanvas(joined);
        })
        .catch(() => {
          // The membership row was created successfully either way (the
          // redeem call itself already succeeded) — a failure here just
          // means staying on the project list instead of jumping straight
          // in, which the user can still do manually.
        });
    },
    [enterCanvas],
  );

  // The canvas gets the whole viewport with no shared chrome above it
  // (it renders its own compact title/back bar, see CanvasView.tsx) — partly
  // because React Flow wants to own its full container's height for
  // pan/zoom to feel right, and partly because that's the more app-like
  // "editor takes over the screen" feel PLAN.md's Ferrumium-inspired visual
  // direction is going for. `CanvasView` mounts its own `<ThemeToggle>`
  // (Job 014) rather than one being passed down from here, precisely
  // because there's no shared chrome to put it in.
  // `localUser` is only ever `null` when `auth.status !== "authenticated"`
  // (see its own `useMemo` above) — this branch already requires
  // `auth.status === "authenticated"`, so the two are always in sync in
  // practice; the explicit `localUser &&` guard here is just what lets
  // TypeScript see that too, without a non-null assertion.
  if (auth.status === "authenticated" && view.name === "canvas" && localUser) {
    return (
      <main className="bg-[var(--surface-app)] text-[var(--text-primary)]">
        <CanvasView
          key={view.project.id}
          projectId={view.project.id}
          projectTitle={view.project.title}
          projectShortId={view.project.shortId}
          role={view.project.role}
          localUser={localUser}
          onBack={leaveCanvas}
        />
      </main>
    );
  }

  // Guest-mode work: same full-viewport treatment as the cloud canvas above
  // — `GuestCanvasView` renders its own compact header/back bar, same as
  // `CanvasView` does. Independent of `auth.status`: a guest canvas is
  // never gated on being logged in.
  if (guestMode && view.name === "guestCanvas") {
    return (
      <main className="bg-[var(--surface-app)] text-[var(--text-primary)]">
        <GuestCanvasView
          key={view.project.id}
          guestId={view.project.id}
          projectTitle={view.project.title}
          onBack={leaveGuestCanvas}
        />
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-[var(--surface-app)] text-[var(--text-primary)]">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-3">
        {/* Job 028: `APP_NAME` ("Satisfactory Modeler") is the original
            *desktop* tool's own name — reusing that key here would render
            the wrong app name, since this reimplementation deliberately has
            its own ("Satisfactory Colab Modeler", PLAN.md's title). New
            `app` namespace key, not a reused/adjusted `APP_NAME`. */}
        <h1 className="text-lg font-semibold tracking-tight">{t("app.title")}</h1>

        <div className="flex items-center gap-3">
          {auth.status === "loading" && (
            <span className="text-sm text-[var(--text-muted)]">{t("app.checkingLogin")}</span>
          )}
          {auth.status === "anonymous" && (
            <div className="flex items-center gap-2">
              {/* Guest-mode work: reopens the explainer, this time offering to exit — see `showGuestModeInfo`'s own comment. */}
              {guestMode && (
                <button
                  type="button"
                  onClick={() => void showGuestModeInfo()}
                  title={t("guestMode.badgeTitle")}
                  className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  {t("guestMode.canvasBadge")}
                </button>
              )}
              <a
                href="/auth/discord/login"
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
              >
                {t("app.logInWithDiscord")}
              </a>
            </div>
          )}
          {auth.status === "authenticated" && (
            <div className="flex items-center gap-3 text-sm">
              <span>
                {t("app.loggedInAsPrefix")} <strong>{auth.user.globalName ?? auth.user.username}</strong>
              </span>
              <a href="/auth/logout" className="text-[var(--text-muted)] underline hover:text-[var(--text-primary)]">
                {t("app.logOut")}
              </a>
            </div>
          )}
          <button
            type="button"
            onClick={openSettings}
            title={t("settingsPage.navLabel")}
            className="rounded-md border border-[var(--border-default)] bg-[var(--surface-panel)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {t("settingsPage.navLabel")}
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      {/* Job 022: a pending `/i/:token` share link takes priority over both
          the login prompt and the project list — see this file's header
          comment for the full detection/carry-over flow. Renders its own
          "log in with Discord" prompt when anonymous, so the generic route
          guard below is skipped while a token is pending. */}
      {auth.status !== "loading" && pendingInviteToken && (
        <InviteRedeemPage
          token={pendingInviteToken}
          isAuthenticated={auth.status === "authenticated"}
          onRedeemed={handleInviteRedeemed}
          onDismiss={dismissPendingInvite}
        />
      )}

      {/* Settings is reachable regardless of auth state (it currently only
          holds the language picker, a plain browser-level preference with
          no account dependency — same as the header's `<ThemeToggle>`), so
          it's checked before the auth route guard below rather than being
          gated behind it. */}
      {!pendingInviteToken && view.name === "settings" && <UserSettingsPage onBack={closeSettings} />}

      {/* While a `/p/:shortId/edit` deep link (e.g. a page refresh mid-project)
          is being resolved back to a project, show the same loading state
          as the initial auth check rather than flashing the project list
          first — see the `initialProjectShortId` effect above. */}
      {!pendingInviteToken && view.name !== "settings" && auth.status === "authenticated" && resolvingProjectLink && (
        <div className="mx-auto max-w-3xl px-4 py-16 text-center text-[var(--text-muted)]">{t("app.loading")}</div>
      )}

      {/* Route guard: only an authenticated user gets past this point to
          the project list / canvas. A logged-out, non-guest visitor gets
          the landing page instead of a bare prompt — see `LandingPage.tsx`.
          Guest-mode work: `!guestMode` here hands off to the guest branch
          below instead, so the two are mutually exclusive by construction,
          not by render order alone. */}
      {!pendingInviteToken && view.name !== "settings" && !guestMode && auth.status !== "authenticated" && (
        auth.status === "loading" ? (
          <div className="mx-auto max-w-3xl px-4 py-16 text-center text-[var(--text-muted)]">{t("app.loading")}</div>
        ) : (
          <LandingPage onContinueAsGuest={() => void enterGuestMode()} />
        )
      )}

      {/* Guest-mode work: a real login always takes priority over a stale
          guest flag (see `GUEST_MODE_STORAGE_KEY`'s own comment) — hence
          the explicit `auth.status !== "authenticated"` guard here too,
          not just `guestMode` alone. */}
      {!pendingInviteToken &&
        view.name !== "settings" &&
        guestMode &&
        auth.status !== "authenticated" && <GuestProjectsPage onOpenProject={enterGuestCanvas} />}

      {/* Guest-mode work: while the just-signed-in import is running, hold
          off on mounting `<ProjectsPage>` — its own `listProjects()` fetch
          runs once on mount with no way for this component to trigger a
          refetch afterward, so mounting it before the import finishes
          would show the list without the projects just added to it. */}
      {!pendingInviteToken &&
        auth.status === "authenticated" &&
        view.name === "projects" &&
        !resolvingProjectLink &&
        guestImportBusy && (
          <div className="mx-auto max-w-3xl px-4 py-16 text-center text-[var(--text-muted)]">
            {t("guestMode.importingNotice")}
          </div>
        )}

      {!pendingInviteToken &&
        auth.status === "authenticated" &&
        view.name === "projects" &&
        !resolvingProjectLink &&
        !guestImportBusy && (
          <>
            {/* Guest-mode work: the "N guest project(s) added to your
                account" summary, once — same dismissible-banner shape as
                `ProjectsPage.tsx`'s own `notice` state, kept here (a
                sibling above it) rather than threaded in as a prop, since
                this is a one-time App-level event, not something
                `ProjectsPage` itself needs to know how to produce. */}
            {guestImportNotice && (
              <div className="mx-auto max-w-3xl px-4 pt-6">
                <div className="rounded-md border border-[var(--outpost-border)] bg-[var(--outpost-soft)] px-3 py-2 text-sm text-[var(--outpost)]">
                  {guestImportNotice}
                  <button type="button" onClick={() => setGuestImportNotice(null)} className="ml-3 underline">
                    {t("projects.dismiss")}
                  </button>
                </div>
              </div>
            )}
            <ProjectsPage onOpenProject={enterCanvas} />
          </>
        )}

      <ConfirmDialog {...confirmDialogProps} />
    </main>
  );
}

export default App;
