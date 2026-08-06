import { useEffect, useState } from "react";

// Minimal shape of GET /auth/me's response body (apps/api/src/auth/routes.ts).
interface CurrentUser {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
}

type AuthState = { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; user: CurrentUser };

function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

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
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Satisfactory Colab Modeler</h1>
      <p className="text-neutral-400">Scaffold placeholder — the canvas editor lands in later jobs.</p>

      {/* Bare login affordance sufficient to exercise the Discord OAuth
          flow manually (Job 005). The real project-list-adjacent UI is
          Job 006's job. */}
      <div className="mt-4">
        {auth.status === "loading" && <span className="text-neutral-500">Checking login status…</span>}
        {auth.status === "anonymous" && (
          <a
            href="/auth/discord/login"
            className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
          >
            Log in with Discord
          </a>
        )}
        {auth.status === "authenticated" && (
          <div className="flex items-center gap-3">
            <span>
              Logged in as <strong>{auth.user.globalName ?? auth.user.username}</strong>
            </span>
            <a href="/auth/logout" className="text-sm text-neutral-400 underline hover:text-neutral-200">
              Log out
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

export default App;
