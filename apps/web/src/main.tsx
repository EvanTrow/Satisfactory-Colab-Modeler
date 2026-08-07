import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initI18n } from "./i18n";

// Job 028: i18next must finish its (near-instant, since en-US is bundled
// synchronously — see `i18n/i18n.ts`) init before the first render, so
// `useTranslation()` never sees an un-initialized instance. Only awaits a
// dynamic import in the (rare) case the persisted/browser locale isn't
// en-US — see `initI18n`'s own resolution order.
void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
