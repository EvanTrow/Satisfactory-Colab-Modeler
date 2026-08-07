// Job 020: real entry point, replacing Job 001's placeholder. See
// `server.ts` for the actual Hocuspocus wiring — this file just starts it
// and wires a clean shutdown, mirroring `apps/api/src/index.ts`'s own
// signal-handling shape.
import { getRealtimeConfig } from "./config.js";
import { createHocuspocusServer } from "./server.js";

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
