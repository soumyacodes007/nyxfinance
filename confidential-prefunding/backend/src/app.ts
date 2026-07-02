import Fastify from "fastify";
import type { AppConfig } from "./lib/env.js";
import type { AppDatabase } from "./db/sqlite.js";
import { registerAnchorCallbackRoutes } from "./routes/anchor-callbacks.js";
import { registerCreditLineRoutes } from "./routes/credit-line.js";
import { registerDemoStateRoutes } from "./routes/demo-state.js";
import { registerDisclosureRoutes } from "./routes/disclosure.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProofRoutes } from "./routes/proof.js";
import { registerQuoteRoutes } from "./routes/quote.js";
import { registerRepaymentHistoryRoutes } from "./routes/repayment-history.js";
import { registerWatcherRoutes } from "./routes/watcher.js";

export const buildApi = async (config: AppConfig, db: AppDatabase) => {
  const app = Fastify({ logger: true });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization");
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { validation?: unknown };
    const statusCode = err.validation ? 400 : 500;
    reply.code(statusCode).send({
      error: err.message
    });
  });

  await registerHealthRoutes(app, config);
  await registerDemoStateRoutes(app, config, db);
  await registerAnchorCallbackRoutes(app, config, db);
  await registerQuoteRoutes(app, config, db);
  await registerProofRoutes(app, db);
  await registerCreditLineRoutes(app, config, db);
  await registerRepaymentHistoryRoutes(app, config, db);
  await registerDisclosureRoutes(app, config, db);
  await registerWatcherRoutes(app, config, db);
  return app;
};
