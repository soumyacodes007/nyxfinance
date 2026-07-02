import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/sqlite.js";
import {
  createCollateralSufficiencyJob,
  createRepaymentHistoryJob,
  getProofJobById
} from "../services/proof-jobs.js";

const collateralProofSchema = z.object({
  quoteId: z.string().optional(),
  collateralAmount: z.string().regex(/^[0-9]+$/),
  collateralRandomness: z.string().regex(/^[0-9]+$/),
  creditAmount: z.string().regex(/^[0-9]+$/),
  creditRandomness: z.string().regex(/^[0-9]+$/),
  positionSecret: z.string().regex(/^[0-9]+$/),
  collateralCommitmentX: z.string().regex(/^[0-9]+$/),
  collateralCommitmentY: z.string().regex(/^[0-9]+$/),
  creditCommitmentX: z.string().regex(/^[0-9]+$/),
  creditCommitmentY: z.string().regex(/^[0-9]+$/),
  lockKey: z.string().regex(/^[0-9]+$/),
  positionNullifier: z.string().regex(/^[0-9]+$/),
  oraclePriceE7: z.string().regex(/^[0-9]+$/),
  haircutBps: z.number().int().min(0).max(10000),
  tenorDays: z.number().int().positive().max(5)
});

const repaymentHistoryProofSchema = z.object({
  positionId: z.string().regex(/^[0-9]+$/),
  repaymentAmount0: z.string().regex(/^[0-9]+$/),
  paidLedger0: z.number().int().nonnegative(),
  dueLedger0: z.number().int().nonnegative(),
  leafSecret0: z.string().regex(/^[0-9]+$/),
  repaymentAmount1: z.string().regex(/^[0-9]+$/),
  paidLedger1: z.number().int().nonnegative(),
  dueLedger1: z.number().int().nonnegative(),
  leafSecret1: z.string().regex(/^[0-9]+$/),
  repaymentAmount2: z.string().regex(/^[0-9]+$/),
  paidLedger2: z.number().int().nonnegative(),
  dueLedger2: z.number().int().nonnegative(),
  leafSecret2: z.string().regex(/^[0-9]+$/),
  proofSecret: z.string().regex(/^[0-9]+$/),
  historyRoot: z.string().regex(/^[0-9]+$/),
  threshold: z.number().int().positive().max(3),
  proofNullifier: z.string().regex(/^[0-9]+$/)
});

export const registerProofRoutes = async (
  app: FastifyInstance,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/proof/collateral-sufficiency", async (request) =>
    createCollateralSufficiencyJob(db, collateralProofSchema.parse(request.body))
  );

  app.post("/api/proof/repayment-history", async (request) =>
    createRepaymentHistoryJob(db, repaymentHistoryProofSchema.parse(request.body))
  );

  app.get("/api/proof/:jobId", async (request, reply) => {
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const job = getProofJobById(db, params.jobId);
    if (!job) return reply.code(404).send({ error: "proof_job_not_found" });
    return job;
  });
};
