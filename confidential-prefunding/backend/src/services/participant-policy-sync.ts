import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import { buildRpcServer } from "./stellar-rpc.js";

export type ParticipantPolicySyncResult =
  | { synced: true; hash: string; ledger?: number }
  | { synced: false; reason: string };

export const syncParticipantPolicy = async (
  config: AppConfig,
  account: string,
  approved: boolean
): Promise<ParticipantPolicySyncResult> => {
  const contractId = config.contracts.participantPolicy;
  const operatorSecret = config.participantPolicyOperatorSecretKey;
  if (!contractId) return { synced: false, reason: "PARTICIPANT_POLICY_CONTRACT_ID is not configured" };
  if (!operatorSecret) return { synced: false, reason: "PARTICIPANT_POLICY_OPERATOR_SECRET_KEY is not configured" };

  const operator = StellarSdk.Keypair.fromSecret(operatorSecret);
  const rpc = buildRpcServer(config);
  const source = await rpc.getAccount(operator.publicKey());
  const contract = new StellarSdk.Contract(contractId);
  let tx = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.stellarNetworkPassphrase
  })
    .addOperation(
      contract.call(
        "set_participant",
        StellarSdk.Address.fromString(account).toScVal(),
        StellarSdk.nativeToScVal(approved),
        StellarSdk.nativeToScVal(1, { type: "u32" }),
        StellarSdk.nativeToScVal(approved ? 1 : 9, { type: "u32" }),
        StellarSdk.nativeToScVal(0, { type: "u32" }),
        StellarSdk.Address.fromString(operator.publicKey()).toScVal()
      )
    )
    .setTimeout(180)
    .build();

  const simulation = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
    return { synced: false, reason: `simulation failed: ${simulation.error}` };
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, simulation).build();
  tx.sign(operator);

  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") {
    return { synced: false, reason: `send failed: ${sent.errorResult}` };
  }

  let txResult = await rpc.getTransaction(sent.hash);
  for (let i = 0; i < 20 && txResult.status === "NOT_FOUND"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    txResult = await rpc.getTransaction(sent.hash);
  }

  if (txResult.status !== "SUCCESS") {
    return { synced: false, reason: `transaction status ${txResult.status}` };
  }
  return { synced: true, hash: sent.hash, ledger: txResult.ledger };
};
