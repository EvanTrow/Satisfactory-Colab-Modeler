import Fastify from "fastify";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = Fastify({
  logger: true,
});

app.get("/health", async () => {
  return { ok: true };
});

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    app.log.info(`api listening at ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
