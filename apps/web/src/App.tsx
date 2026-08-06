import { useEffect, useState } from "react";

import type { ProjectSummary } from "./api/projects";
import { ProjectPlaceholder } from "./routes/ProjectPlaceholder";
import { ProjectsPage } from "./routes/ProjectsPage";

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
 * no router in `apps/web` yet (no library dependency for it, and nothing
 * else has needed real URL-based routing so far) — this is plain React
 * state, not URL-addressable. `routes/index.ts`'s placeholder comment
 * ("Job-later work") is about a real router, which a future job can layer
 * over this if project URLs need to be shareable/bookmarkable; Job 006
 * only needs "click a project -> see a placeholder -> go back."
 */
type View = { name: "projects" } | { name: "project"; project: ProjectSummary };

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [view, setView] = useState<View>({ name: "projects" });

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

  return (
    <main className="min-h-svh bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h1 className="text-lg font-semibold tracking-tight">Satisfactory Colab Modeler</h1>

        <div>
          {auth.status === "loading" && <span className="text-sm text-neutral-500">Checking login status…</span>}
          {auth.status === "anonymous" && (
            <a
              href="/auth/discord/login"
              className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              Log in with Discord
            </a>
          )}
          {auth.status === "authenticated" && (
            <div className="flex items-center gap-3 text-sm">
              <span>
                Logged in as <strong>{auth.user.globalName ?? auth.user.username}</strong>
              </span>
              <a href="/auth/logout" className="text-neutral-400 underline hover:text-neutral-200">
                Log out
              </a>
            </div>
          )}
        </div>
      </header>

      {/* Route guard: only an authenticated user gets past this point to
          the project list / project placeholder. Anonymous and loading
          states render the login prompt above with no project content
          underneath — the closest thing to "redirect to the login flow"
          available without a real router (see the View comment above). */}
      {auth.status !== "authenticated" && (
        <div className="mx-auto max-w-3xl px-4 py-16 text-center text-neutral-400">
          {auth.status === "loading" ? "Loading…" : "Log in with Discord to see your projects."}
        </div>
      )}

      {auth.status === "authenticated" && view.name === "projects" && (
        <ProjectsPage onOpenProject={(project) => setView({ name: "project", project })} />
      )}

      {auth.status === "authenticated" && view.name === "project" && (
        <ProjectPlaceholder project={view.project} onBack={() => setView({ name: "projects" })} />
      )}
    </main>
  );
}

export default App;
