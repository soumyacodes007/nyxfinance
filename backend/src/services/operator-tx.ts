import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import { buildRpcServer } from "./stellar-rpc.js";

export type OperatorTxResult = { hash: string; ledger: number };

type QueueTask<T> = () => Promise<T>;

let queue: Promise<unknown> = Promise.resolve();

export const enqueueOperatorTx = async <T>(task: QueueTask<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
};

export const operatorKeypair = (config: AppConfig): StellarSdk.Keypair => {
  if (!config.participantPolicyOperatorSecretKey) {
    throw new Error("PARTICIPANT_POLICY_OPERATOR_SECRET_KEY is not configured");
  }
  return StellarSdk.Keypair.fromSecret(config.participantPolicyOperatorSecretKey);
};

export const keypairFromSecret = (secretKey: string | null, envName: string): StellarSdk.Keypair => {
  if (!secretKey) throw new Error(`${envName} is not configured`);
  return StellarSdk.Keypair.fromSecret(secretKey);
};

const contractErrorLabels: Record<string, string> = {
  "3506": "OZ ConfidentialToken InvalidProof",
  "4504": "PrefundingCreditLine StaleOraclePrice",
  "4505": "PrefundingCreditLine ProofNotApproved",
  "4511": "PrefundingCreditLine ProofVerificationFailed",
  "4702": "RepaymentHistory DuplicateProofNullifier",
  "4704": "RepaymentHistory ProofVerificationFailed"
};

const summarizeSimulationError = (method: string, error: string): string => {
  const contractError = error.match(/Error\(Contract,\s*#(\d+)\)/);
  const verifierFalse = /verify_proof\], data:false/.test(error) || /verify_proof.*data:false/s.test(error);
  const code = contractError?.[1];
  const label = code ? contractErrorLabels[code] ?? `Contract error #${code}` : "simulation error";
  const proofHint =
    code === "3506" && verifierFalse
      ? " The configured confidential transfer proof was rejected by the OZ verifier; refresh the draw/repayment proof-of-life artifacts before retrying."
      : "";
  return `${method} simulation failed: ${label}.${proofHint}`;
};

export const submitContractCallWithKeypair = async (
  config: AppConfig,
  signer: StellarSdk.Keypair,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<OperatorTxResult> => submitContractCallWithSigners(config, signer, [], contractId, method, args);

// Some invocations (e.g. `open_credit`, which requires both the operator's
// manager-role auth and the anchor's own `require_auth()` per K3) need more
// than one address to authorize the same call. `txSigner` signs the
// transaction envelope (its account is the tx source); `authSigners` covers
// any OTHER address-credentialed Soroban auth entries the simulation comes
// back with, matched by public key. See the "multi-party auth" pattern in
// `authorizeEntry`'s SDK docs.
export const submitContractCallWithSigners = async (
  config: AppConfig,
  txSigner: StellarSdk.Keypair,
  authSigners: StellarSdk.Keypair[],
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<OperatorTxResult> =>
  enqueueOperatorTx(async () => {
    const rpc = buildRpcServer(config);
    const source = await rpc.getAccount(txSigner.publicKey());
    const contract = new StellarSdk.Contract(contractId);
    let tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: config.stellarNetworkPassphrase
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(180)
      .build();

    const simulation = await rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
      throw new Error(summarizeSimulationError(method, simulation.error));
    }

    if (authSigners.length > 0 && simulation.result) {
      const latestLedger = await rpc.getLatestLedger();
      const validUntilLedgerSeq = latestLedger.sequence + 200;
      simulation.result.auth = await Promise.all(
        simulation.result.auth.map(async (entry) => {
          if (entry.credentials().switch().name !== "sorobanCredentialsAddress") return entry;
          const requiredAddress = StellarSdk.Address.fromScAddress(
            entry.credentials().address().address()
          ).toString();
          const matchingSigner = authSigners.find((kp) => kp.publicKey() === requiredAddress);
          if (!matchingSigner) return entry;
          return StellarSdk.authorizeEntry(
            entry,
            matchingSigner,
            validUntilLedgerSeq,
            config.stellarNetworkPassphrase
          );
        })
      );
    }

    tx = StellarSdk.rpc.assembleTransaction(tx, simulation).build();
    tx.sign(txSigner);

    const sent = await rpc.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`${method} send failed: ${sent.errorResult}`);
    }

    let txResult = await rpc.getTransaction(sent.hash);
    for (let i = 0; i < 30 && txResult.status === "NOT_FOUND"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      txResult = await rpc.getTransaction(sent.hash);
    }
    if (txResult.status !== "SUCCESS") {
      throw new Error(`${method} transaction status ${txResult.status}`);
    }
    return { hash: sent.hash, ledger: txResult.ledger };
  });

export const submitOperatorContractCall = async (
  config: AppConfig,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<OperatorTxResult> =>
  submitContractCallWithKeypair(config, operatorKeypair(config), contractId, method, args);
