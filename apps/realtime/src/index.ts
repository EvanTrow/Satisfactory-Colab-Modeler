// Job 020: real entry point, replacing Job 001's placeholder. See
// `server.ts` for the actual Hocuspocus wiring — this file just starts it
// and wires a clean shutdown, mirroring `apps/api/src/index.ts`'s own
// signal-handling shape.
import { getRealtimeConfig } from "./config.js";
import { captureException, initSentry } from "./monitoring/sentry.js";
import { createHocuspocusServer } from "./server.js";

// Job 029: see apps/api/src/index.ts's own header comment for the full
// reasoning — same no-op-when-unset contract, same "report then preserve
// Node's existing crash-on-uncaught-error behavior" choice.
initSentry();
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

async function main(): Promise<void> {
  const { wsPort, internalPort } = getRealtimeConfig();
  const realtime = await createHocuspocusServer();
  console.log(`[realtime] Hocuspocus listening on ws://localhost:${wsPort} (internal webhook on :${internalPort})`);

  const shutdown = async (signal: string) => {
    console.log(`[realtime] received ${signal}, shutting down...`);
    await realtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[realtime] failed to start", err);
  process.exitCode = 1;
});
