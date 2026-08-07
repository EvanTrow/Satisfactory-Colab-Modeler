import { buildApp } from "./app.js";
import { captureException, initSentry } from "./monitoring/sentry.js";

// Job 029: as early as possible, before anything else in this process can
// throw — see monitoring/sentry.ts's header comment for the no-op-when-
// unset contract every other call in this file relies on.
initSentry();

// Reports a genuinely uncaught exception/rejection to Sentry, THEN
// preserves Node's own default outcome for both — verified live (no
// listener registered, Node 20/26): an uncaught exception OR an unhandled
// promise rejection both already crash the process today (Node's default
// `--unhandled-rejections=throw` since Node 15, not the older "just warn"
// behavior). Registering a listener at all suppresses that default, so
// both handlers below explicitly re-exit(1) to keep the exact same
// crash-don't-limp-along behavior this app already had — the Sentry
// report is the only actual change.
process.on("uncaughtException", (error) => {
  captureException(error, { source: "uncaughtException" });
  console.error(error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  captureException(reason, { source: "unhandledRejection" });
  console.error(reason);
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    app.log.info(`api listening at ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
