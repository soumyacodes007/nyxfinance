import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { syncWatcherOnce } from "../services/watcher.js";

export const registerWatcherRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/watcher/sync", async (request, reply) => {
    try {
      return await syncWatcherOnce(config, db);
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
};
