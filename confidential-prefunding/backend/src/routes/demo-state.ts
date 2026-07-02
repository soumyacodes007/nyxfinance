import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { getDemoState } from "../services/demo-state.js";

export const registerDemoStateRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.get("/api/demo/state", async (_request, reply) => {
    const state = await getDemoState(config, db);
    return reply.code(state.source === "unavailable" ? 503 : 200).send(state);
  });
};
