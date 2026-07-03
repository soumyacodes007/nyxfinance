import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  bootstrapDemoFlow,
  drawDemoCredit,
  getDemoFlowState,
  openDemoCredit,
  proveDemoRepaymentHistory,
  repayDemoCredit
} from "../services/demo-flow.js";

const flowActionSchema = z.object({
  anchorTransactionId: z.string().min(1).optional(),
  quoteId: z.string().min(1).optional(),
  positionId: z.string().min(1).optional()
});

const bootstrapSchema = z.object({
  anchorTransactionId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  kybStatus: z.string().min(1).optional()
});

const sendActionError = (reply: FastifyReply, error: unknown) =>
  reply.code(422).send({
    error: error instanceof Error ? error.message : String(error)
  });

export const registerDemoFlowRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.get("/api/demo-flow/state", async () => getDemoFlowState(config, db));

  app.post("/api/demo-flow/bootstrap", async (request, reply) => {
    try {
      const body = bootstrapSchema.parse(request.body ?? {});
      return await bootstrapDemoFlow(config, db, body);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });

  app.post("/api/demo-flow/open", async (request, reply) => {
    try {
      const body = flowActionSchema.parse(request.body ?? {});
      return await openDemoCredit(config, db, body);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });

  app.post("/api/demo-flow/draw", async (request, reply) => {
    try {
      const body = flowActionSchema.parse(request.body ?? {});
      return await drawDemoCredit(config, db, body);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });

  app.post("/api/demo-flow/repay", async (request, reply) => {
    try {
      const body = flowActionSchema.parse(request.body ?? {});
      return await repayDemoCredit(config, db, body);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });

  app.post("/api/demo-flow/history-proof", async (request, reply) => {
    try {
      const body = flowActionSchema.parse(request.body ?? {});
      return await proveDemoRepaymentHistory(config, db, body);
    } catch (error) {
      return sendActionError(reply, error);
    }
  });
};
