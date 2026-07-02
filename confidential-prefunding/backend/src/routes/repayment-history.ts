import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  seedRepaymentLeaf,
  setRepaymentHistoryRoot,
  verifyRepaymentHistory
} from "../services/repayment-history.js";

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const hexBytes = z.string().regex(/^(0x)?[0-9a-fA-F]+$/);

const seedLeafSchema = z.object({
  positionId: hex32,
  leafNullifier: hex32,
  repaymentCommitment: hex32,
  paidLedger: z.number().int().nonnegative(),
  dueLedger: z.number().int().nonnegative()
});

const rootSchema = z.object({
  positionId: hex32,
  historyRoot: hex32,
  leafCount: z.number().int().positive()
});

const verifySchema = z.object({
  positionId: hex32,
  threshold: z.number().int().positive().max(3),
  proofNullifier: hex32,
  publicInputsHex: hexBytes,
  proofHex: hexBytes
});

export const registerRepaymentHistoryRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/repayment-history/seed-leaf", async (request, reply) => {
    try {
      return await seedRepaymentLeaf(config, db, seedLeafSchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/repayment-history/root", async (request, reply) => {
    try {
      return await setRepaymentHistoryRoot(config, rootSchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/repayment-history/verify", async (request, reply) => {
    try {
      return await verifyRepaymentHistory(config, verifySchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
