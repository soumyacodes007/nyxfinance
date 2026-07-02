import Fastify from "fastify";
import { openAppDatabase } from "../../src/db/sqlite.js";
import { config } from "../../src/lib/env.js";
import { registerBusinessCallbackRoutes } from "../../src/routes/anchor-callbacks.js";

const db = openAppDatabase(config.appStateDbPath);
const app = Fastify({ logger: true });

app.setErrorHandler((error, _request, reply) => {
  const err = error as Error & { validation?: unknown };
  reply.code(err.validation ? 400 : 500).send({ error: err.message });
});

await registerBusinessCallbackRoutes(app, config, db);
await app.listen({ port: config.businessServerPort, host: "0.0.0.0" });
