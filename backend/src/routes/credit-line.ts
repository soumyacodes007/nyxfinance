import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { executeDraw, openCreditLine, repayCreditLine } from "../services/credit-line.js";

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);
const hexBytes = z.string().regex(/^(0x)?[0-9a-fA-F]+$/);
const confidentialTransferSchema = z.object({
  tokenContractId: z.string().min(1).optional(),
  method: z.enum(["confidential_transfer", "confidential_transfer_from"]).optional(),
  spender: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  dataXdrBase64: z.string().min(1),
  mergeBeforeTransfer: z.boolean().optional(),
  auditorPayload: z.record(z.unknown()).optional(),
  eventPayload: z.record(z.unknown()).optional()
});

const openCreditSchema = z.object({
  anchorTransactionId: z.string().optional(),
  positionId: hex32,
  anchor: z.string().min(1),
  anchorSecretKey: z.string().min(1),
  collateralToken: z.string().optional(),
  lockKey: hex32,
  creditCommitmentX: hex32,
  creditCommitmentY: hex32,
  oraclePriceE7: z.string().regex(/^[0-9]+$/),
  haircutBps: z.number().int().min(0).max(10000),
  tenorDays: z.number().int().positive().max(5),
  positionNullifier: hex32,
  publicInputsHex: hexBytes,
  proofHex: hexBytes
});

const drawSchema = z.object({
  anchorTransactionId: z.string().optional(),
  positionId: hex32,
  facility: z.string().min(1),
  transferCommitmentX: hex32,
  transferCommitmentY: hex32,
  creditExecutorSecretKey: z.string().min(1),
  confidentialTransfer: confidentialTransferSchema
});

const repaySchema = z.object({
  anchorTransactionId: z.string().optional(),
  positionId: hex32,
  facility: z.string().min(1),
  anchorSecretKey: z.string().min(1),
  repaymentCommitment: hex32,
  confidentialTransfer: confidentialTransferSchema
});

export const registerCreditLineRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/prefunding/open", async (request, reply) => {
    try {
      return await openCreditLine(config, db, openCreditSchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/prefunding/draw", async (request, reply) => {
    try {
      return await executeDraw(config, db, drawSchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/prefunding/repay", async (request, reply) => {
    try {
      return await repayCreditLine(config, db, repaySchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
