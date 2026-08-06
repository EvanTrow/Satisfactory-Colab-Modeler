import { useCallback, useEffect, useState } from "react";

import type { ProjectSummary } from "./api/projects";
import { CanvasView } from "./canvas";
import { ProjectsPage } from "./routes/ProjectsPage";
import { ThemeToggle, useTheme } from "./theme";

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
 * Router or similar. `routes/index.ts`'s placeholder comment ("Job-later
 * work") is about a real router, which a future job can layer over this if
 * project URLs need to be shareable/bookmarkable.
 *
 * Job 008 pushes a `/p/:shortId/edit` URL into the address bar (via the
 * History API directly, see `enterCanvas`/`leaveCanvas` below) purely so
 * the browser's address bar reflects what's on screen and the back button
 * works — it is NOT a real deep link. Loading that URL fresh (or
 * refreshing) does not reconstruct this view: `App` always boots into
 * `{ name: "projects" }` and only gets to `"canvas"` by clicking a project,
 * same as Job 006 did with the placeholder this replaces. Wiring an actual
 * deep link would need a `GET /api/projects/by-short-id/:shortId`-style
 * endpoint that doesn't exist yet — explicitly out of this job's scope
 * (no backend/API changes).
 */
type View = { name: "projects" } | { name: "canvas"; project: ProjectSummary };

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [view, setView] = useState<View>({ name: "projects" });
  // Job 014: mounted once here (not just inside `CanvasView.tsx`) precisely
  // because "app-level, not canvas-only" is the whole point — see
  // `theme/useTheme.ts`'s header comment. Both mounts share the same
  // localStorage-backed state; only one of the two views is ever on screen
  // at once, so there's no risk of them fighting each other.
  const { theme, toggleTheme } = useTheme();

  const enterCanvas = useCallback((project: ProjectSummary) => {
    setView({ name: "canvas", project });
    window.history.pushState({ shortId: project.shortId }, "", `/p/${project.shortId}/edit`);
  }, []);

  const leaveCanvas = useCallback(() => {
    setView({ name: "projects" });
    window.history.pushState({}, "", "/");
  }, []);

  // Browser back button while the canvas is open: pop out to the project
  // list instead of leaving the SPA (there's nowhere else for this History
  // entry to go, since `enterCanvas` never pushed more than one level).
  useEffect(() => {
    function onPopState() {
      setView((current) => (current.name === "canvas" ? { name: "projects" } : current));
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

  // The canvas gets the whole viewport with no shared chrome above it
  // (it renders its own compact title/back bar, see CanvasView.tsx) — partly
  // because React Flow wants to own its full container's height for
  // pan/zoom to feel right, and partly because that's the more app-like
  // "editor takes over the screen" feel PLAN.md's Ferrumium-inspired visual
  // direction is going for. `CanvasView` mounts its own `<ThemeToggle>`
  // (Job 014) rather than one being passed down from here, precisely
  // because there's no shared chrome to put it in.
  if (auth.status === "authenticated" && view.name === "canvas") {
    return (
      <main className="bg-[var(--surface-app)] text-[var(--text-primary)]">
        <CanvasView
          key={view.project.id}
          projectTitle={view.project.title}
          projectShortId={view.project.shortId}
          onBack={leaveCanvas}
        />
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-[var(--surface-app)] text-[var(--text-primary)]">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Satisfactory Colab Modeler</h1>

        <div className="flex items-center gap-3">
          {auth.status === "loading" && (
            <span className="text-sm text-[var(--text-muted)]">Checking login status…</span>
          )}
          {auth.status === "anonymous" && (
            <a
              href="/auth/discord/login"
              className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)]"
            >
              Log in with Discord
            </a>
          )}
          {auth.status === "authenticated" && (
            <div className="flex items-center gap-3 text-sm">
              <span>
                Logged in as <strong>{auth.user.globalName ?? auth.user.username}</strong>
              </span>
              <a href="/auth/logout" className="text-[var(--text-muted)] underline hover:text-[var(--text-primary)]">
                Log out
              </a>
            </div>
          )}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      {/* Route guard: only an authenticated user gets past this point to
          the project list / canvas. Anonymous and loading states render the
          login prompt above with no project content underneath — the
          closest thing to "redirect to the login flow" available without a
          real router (see the View comment above). */}
      {auth.status !== "authenticated" && (
        <div className="mx-auto max-w-3xl px-4 py-16 text-center text-[var(--text-muted)]">
          {auth.status === "loading" ? "Loading…" : "Log in with Discord to see your projects."}
        </div>
      )}

      {auth.status === "authenticated" && view.name === "projects" && (
        <ProjectsPage onOpenProject={enterCanvas} />
      )}
    </main>
  );
}

export default App;
