import type { AppDatabase } from "../db/sqlite.js";
import { getProofJob, insertProofJob } from "../db/sqlite.js";
import { newId, nowIso } from "../lib/ids.js";
import type {
  CollateralSufficiencyProofPayload,
  ProofJob,
  ProofJobType,
  RepaymentHistoryProofPayload
} from "../types/proof.js";

export const createProofJob = <TPayload>(
  db: AppDatabase,
  type: ProofJobType,
  payload: TPayload
): ProofJob<TPayload> => {
  const now = nowIso();
  const job: ProofJob<TPayload> = {
    id: newId("proof"),
    type,
    status: "queued",
    payload,
    result: null,
    error: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  insertProofJob(db, job);
  return job;
};

export const getProofJobById = (db: AppDatabase, id: string): ProofJob | null => getProofJob(db, id);

export const createCollateralSufficiencyJob = (
  db: AppDatabase,
  payload: CollateralSufficiencyProofPayload
): ProofJob<CollateralSufficiencyProofPayload> =>
  createProofJob(db, "collateral_sufficiency", payload);

export const createRepaymentHistoryJob = (
  db: AppDatabase,
  payload: RepaymentHistoryProofPayload
): ProofJob<RepaymentHistoryProofPayload> =>
  createProofJob(db, "repayment_history", payload);
