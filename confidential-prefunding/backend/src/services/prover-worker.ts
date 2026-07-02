import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { claimNextProofJob, completeProofJob } from "../db/sqlite.js";
import type {
  CollateralSufficiencyProofPayload,
  ProofJob,
  RepaymentHistoryProofPayload
} from "../types/proof.js";

const run = (command: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        PATH: [
          resolve(cwd, "../scripts/bin"),
          process.env.HOME ? resolve(process.env.HOME, ".nargo/bin") : null,
          process.env.HOME ? resolve(process.env.HOME, ".bb") : null,
          process.env.PATH ?? ""
        ]
          .filter((value): value is string => Boolean(value))
          .join(":")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`));
    });
  });

const writeProverToml = (root: string, payload: CollateralSufficiencyProofPayload): void => {
  const circuitDir = join(root, "circuits", "collateral_sufficiency");
  const fields: Record<string, string | number> = {
    collateral_amount: payload.collateralAmount,
    collateral_randomness: payload.collateralRandomness,
    credit_amount: payload.creditAmount,
    credit_randomness: payload.creditRandomness,
    position_secret: payload.positionSecret,
    collateral_commitment_x: payload.collateralCommitmentX,
    collateral_commitment_y: payload.collateralCommitmentY,
    credit_commitment_x: payload.creditCommitmentX,
    credit_commitment_y: payload.creditCommitmentY,
    oracle_price_e7: payload.oraclePriceE7,
    haircut_bps: payload.haircutBps,
    tenor_days: payload.tenorDays,
    lock_key: payload.lockKey,
    position_nullifier: payload.positionNullifier
  };
  const content = Object.entries(fields)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
  writeFileSync(join(circuitDir, "Prover.toml"), `${content}\n`);
};

const runCollateralSufficiencyProof = async (
  config: AppConfig,
  job: ProofJob<CollateralSufficiencyProofPayload>
) => {
  const root = resolve(config.ozConfidentialRoot);
  const circuitsDir = join(root, "circuits");
  const outDir = join(root, "state", job.id);
  mkdirSync(outDir, { recursive: true });
  writeProverToml(root, job.payload);

  await run("nargo", ["compile", "--package", "circuit_collateral_sufficiency"], circuitsDir);
  await run("nargo", ["execute", "--package", "circuit_collateral_sufficiency"], circuitsDir);
  await run(
    "bb",
    [
      "prove",
      "--scheme",
      "ultra_honk",
      "--oracle_hash",
      "keccak",
      "--bytecode_path",
      join(circuitsDir, "target", "circuit_collateral_sufficiency.json"),
      "--witness_path",
      join(circuitsDir, "target", "circuit_collateral_sufficiency.gz"),
      "--output_path",
      outDir,
      "--output_format",
      "bytes_and_fields"
    ],
    circuitsDir
  );

  return {
    proofHex: readFileSync(join(outDir, "proof")).toString("hex"),
    publicInputsHex: readFileSync(join(outDir, "public_inputs")).toString("hex"),
    artifactsDir: outDir
  };
};

const writeRepaymentHistoryProverToml = (
  root: string,
  payload: RepaymentHistoryProofPayload
): void => {
  const circuitDir = join(root, "circuits", "repayment_history");
  const fields: Record<string, string | number> = {
    position_id: payload.positionId,
    repayment_amount_0: payload.repaymentAmount0,
    paid_ledger_0: payload.paidLedger0,
    due_ledger_0: payload.dueLedger0,
    leaf_secret_0: payload.leafSecret0,
    repayment_amount_1: payload.repaymentAmount1,
    paid_ledger_1: payload.paidLedger1,
    due_ledger_1: payload.dueLedger1,
    leaf_secret_1: payload.leafSecret1,
    repayment_amount_2: payload.repaymentAmount2,
    paid_ledger_2: payload.paidLedger2,
    due_ledger_2: payload.dueLedger2,
    leaf_secret_2: payload.leafSecret2,
    proof_secret: payload.proofSecret,
    history_root: payload.historyRoot,
    threshold: payload.threshold,
    proof_nullifier: payload.proofNullifier
  };
  const content = Object.entries(fields)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
  writeFileSync(join(circuitDir, "Prover.toml"), `${content}\n`);
};

const runRepaymentHistoryProof = async (
  config: AppConfig,
  job: ProofJob<RepaymentHistoryProofPayload>
) => {
  const root = resolve(config.ozConfidentialRoot);
  const circuitsDir = join(root, "circuits");
  const outDir = join(root, "state", job.id);
  mkdirSync(outDir, { recursive: true });
  writeRepaymentHistoryProverToml(root, job.payload);

  await run("nargo", ["compile", "--package", "circuit_repayment_history"], circuitsDir);
  await run("nargo", ["execute", "--package", "circuit_repayment_history"], circuitsDir);
  await run(
    "bb",
    [
      "prove",
      "--scheme",
      "ultra_honk",
      "--oracle_hash",
      "keccak",
      "--bytecode_path",
      join(circuitsDir, "target", "circuit_repayment_history.json"),
      "--witness_path",
      join(circuitsDir, "target", "circuit_repayment_history.gz"),
      "--output_path",
      outDir,
      "--output_format",
      "bytes_and_fields"
    ],
    circuitsDir
  );

  return {
    proofHex: readFileSync(join(outDir, "proof")).toString("hex"),
    publicInputsHex: readFileSync(join(outDir, "public_inputs")).toString("hex"),
    artifactsDir: outDir
  };
};

export const processNextProofJob = async (
  config: AppConfig,
  db: AppDatabase
): Promise<ProofJob | null> => {
  const job = claimNextProofJob(db);
  if (!job) return null;

  try {
    if (job.type === "collateral_sufficiency") {
      const result = await runCollateralSufficiencyProof(
        config,
        job as ProofJob<CollateralSufficiencyProofPayload>
      );
      completeProofJob(db, job.id, "succeeded", result);
    } else if (job.type === "repayment_history") {
      const result = await runRepaymentHistoryProof(
        config,
        job as ProofJob<RepaymentHistoryProofPayload>
      );
      completeProofJob(db, job.id, "succeeded", result);
    } else {
      throw new Error(`No prover implemented for ${(job as ProofJob).type}`);
    }
  } catch (error) {
    completeProofJob(
      db,
      job.id,
      "failed",
      null,
      error instanceof Error ? error.message : String(error)
    );
  }

  return job;
};
