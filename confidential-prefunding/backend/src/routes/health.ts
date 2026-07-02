import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../lib/env.js";

export const registerHealthRoutes = async (app: FastifyInstance, config: AppConfig): Promise<void> => {
  app.get("/health", async () => ({
    status: "ok",
    service: "api",
    databasePath: config.appStateDbPath,
    timestamp: new Date().toISOString()
  }));
};
