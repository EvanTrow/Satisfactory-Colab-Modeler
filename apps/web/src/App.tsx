import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { listProjects, type ProjectSummary } from "./api/projects";
import { CanvasView } from "./canvas";
import { discordAvatarUrl, type LocalUserIdentity } from "./collab";
import { ProjectsPage } from "./routes/ProjectsPage";
import { UserSettingsPage } from "./routes/UserSettingsPage";
import { InviteRedeemPage } from "./sharing";
import { ThemeToggle, useTheme } from "./theme";

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
  | { name: "settings" };

function App() {
  const { t } = useTranslation("app");
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  // Lazy initializer: `/settings` is the one `View` that's resolvable from
  // the URL alone, with no auth/network round trip needed first (see the
  // `View` comment above) — everything else (`"canvas"`) needs the
  // `initialProjectShortId` effect below because it needs a project fetched
  // by shortId first.
  const [view, setView] = useState<View>(() =>
    window.location.pathname === "/settings" ? { name: "settings" } : { name: "projects" },
  );
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
    setView({ name: "projects" });
    window.history.pushState({}, "", "/");
  }, []);

  // Browser back button while the canvas or settings is open: pop out to
  // the project list instead of leaving the SPA (there's nowhere else for
  // this History entry to go, since neither `enterCanvas` nor
  // `openSettings` ever pushes more than one level).
  useEffect(() => {
    function onPopState() {
      setView((current) => (current.name !== "projects" ? { name: "projects" } : current));
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
            <a
              href="/auth/discord/login"
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              {t("app.logInWithDiscord")}
            </a>
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
          the project list / canvas. Anonymous and loading states render the
          login prompt above with no project content underneath — the
          closest thing to "redirect to the login flow" available without a
          real router (see the View comment above). */}
      {!pendingInviteToken && view.name !== "settings" && auth.status !== "authenticated" && (
        <div className="mx-auto max-w-3xl px-4 py-16 text-center text-[var(--text-muted)]">
          {auth.status === "loading" ? t("app.loading") : t("app.logInPrompt")}
        </div>
      )}

      {!pendingInviteToken && auth.status === "authenticated" && view.name === "projects" && !resolvingProjectLink && (
        <ProjectsPage onOpenProject={enterCanvas} />
      )}
    </main>
  );
}

export default App;
