import { buildApp } from "./app.js";

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
