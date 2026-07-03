import Fastify from "fastify";
import type { AppConfig } from "./lib/env.js";
import type { AppDatabase } from "./db/sqlite.js";
import { registerAnchorCallbackRoutes } from "./routes/anchor-callbacks.js";
import { registerAuditorRoutes } from "./routes/auditor.js";
import { registerCreditLineRoutes } from "./routes/credit-line.js";
import { registerDemoStateRoutes } from "./routes/demo-state.js";
import { registerDemoFlowRoutes } from "./routes/demo-flow.js";
import { registerDisclosureRoutes } from "./routes/disclosure.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOracleRoutes } from "./routes/oracle.js";
import { registerProofRoutes } from "./routes/proof.js";
import { registerQuoteRoutes } from "./routes/quote.js";
import { registerRepaymentHistoryRoutes } from "./routes/repayment-history.js";
import { registerSep12Routes } from "./routes/sep12.js";
import { registerSep31Routes } from "./routes/sep31.js";
import { registerWatcherRoutes } from "./routes/watcher.js";

export const buildApi = async (config: AppConfig, db: AppDatabase) => {
  const app = Fastify({ logger: true });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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
  await registerDemoFlowRoutes(app, config, db);
  await registerAuditorRoutes(app, config, db);
  await registerAnchorCallbackRoutes(app, config, db);
  await registerSep12Routes(app, config, db);
  await registerSep31Routes(app, config, db);
  await registerQuoteRoutes(app, config, db);
  await registerOracleRoutes(app, config);
  await registerProofRoutes(app, db);
  await registerCreditLineRoutes(app, config, db);
  await registerRepaymentHistoryRoutes(app, config, db);
  await registerDisclosureRoutes(app, config, db);
  await registerWatcherRoutes(app, config, db);
  return app;
};
