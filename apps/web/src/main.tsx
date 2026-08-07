import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initI18n } from "./i18n";
import { captureException, initSentry, SentryErrorBoundary } from "./monitoring/sentry";

// Job 029: as early as possible — a no-op unless `VITE_SENTRY_DSN` was set
// at build time (see `monitoring/sentry.ts`'s header comment; no real
// Sentry account/project exists in this sandbox). `window.onerror`/
// `unhandledrejection` catch exceptions React's own render tree never sees
// (event handlers outside `SentryErrorBoundary`'s subtree, timers, etc.);
// `SentryErrorBoundary` below catches exceptions thrown DURING render,
// which those two window-level events never fire for (React swallows a
// render-time throw into its own error boundary protocol instead of
// letting it reach `window.onerror` — this is why both are needed, not
// either alone).
initSentry();
window.addEventListener("error", (event) => {
  captureException(event.error ?? event.message, { source: "window.onerror" });
});
window.addEventListener("unhandledrejection", (event) => {
  captureException(event.reason, { source: "unhandledrejection" });
});

// Job 028: i18next must finish its (near-instant, since en-US is bundled
// synchronously — see `i18n/i18n.ts`) init before the first render, so
// `useTranslation()` never sees an un-initialized instance. Only awaits a
// dynamic import in the (rare) case the persisted/browser locale isn't
// en-US — see `initI18n`'s own resolution order.
void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {/*
        Job 029: reports a render-time exception to Sentry (no-op if
        unconfigured — same contract as everywhere else in this module)
        and falls back to a minimal "something went wrong" message instead
        of an unmounted blank page. Deliberately no retry/reload button —
        this app has no client-side router state worth trying to preserve
        across a forced remount, and a plain browser refresh already does
        the right thing.
      */}
      <SentryErrorBoundary fallback={<p style={{ padding: 24 }}>Something went wrong. Please reload the page.</p>}>
        <App />
      </SentryErrorBoundary>
    </StrictMode>,
  );
});
