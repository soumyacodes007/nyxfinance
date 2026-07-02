import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  getDisclosureBundle,
  insertDisclosureBundle,
  markDisclosureBundleRevoked,
  updateDisclosureBundleOnChainTx
} from "../db/sqlite.js";
import { newId } from "../lib/ids.js";
import { buildRpcServer, fetchLatestLedger } from "./stellar-rpc.js";
import type {
  DisclosureBundlePlaintext,
  DisclosureBundleRecord,
  DisclosureScope,
  EncryptedDisclosureBundle
} from "../types/disclosure.js";

const normalizeHex = (value: string, field: string): string => {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${field} must be even-length hex`);
  }
  return hex.toLowerCase();
};

const bytesArg = (hex: string, field: string): StellarSdk.xdr.ScVal =>
  StellarSdk.nativeToScVal(Buffer.from(normalizeHex(hex, field), "hex"), { type: "bytes" });

const bytes32Arg = (hex: string, field: string): StellarSdk.xdr.ScVal => {
  const normalized = normalizeHex(hex, field);
  if (normalized.length !== 64) throw new Error(`${field} must be 32 bytes`);
  return bytesArg(normalized, field);
};

const addressArg = (address: string): StellarSdk.xdr.ScVal =>
  StellarSdk.Address.fromString(address).toScVal();

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256Hex = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const scopeHash = (scope: DisclosureScope): string => sha256Hex(stableJson(scope));

export const viewerHash = (viewerSecret: string): string => sha256Hex(viewerSecret);

const scopedOnly = (
  data: Record<string, unknown>,
  scope: DisclosureScope
): Record<string, unknown> => {
  const allowed = new Set(scope.fields);
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowed.has(key)));
};

const keyFromViewerSecret = (viewerSecret: string): Buffer =>
  createHash("sha256").update(viewerSecret).digest();

export const encryptDisclosurePlaintext = (
  plaintext: DisclosureBundlePlaintext,
  viewerSecret: string
): EncryptedDisclosureBundle => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromViewerSecret(viewerSecret), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(stableJson(plaintext), "utf8")),
    cipher.final()
  ]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    algorithm: "aes-256-gcm"
  };
};

export const decryptDisclosurePlaintext = (
  encrypted: EncryptedDisclosureBundle,
  viewerSecret: string
): DisclosureBundlePlaintext => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFromViewerSecret(viewerSecret),
    Buffer.from(encrypted.nonce, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as DisclosureBundlePlaintext;
};

const bundleHash = (encrypted: EncryptedDisclosureBundle): string =>
  sha256Hex(`${encrypted.algorithm}:${encrypted.nonce}:${encrypted.authTag}:${encrypted.ciphertext}`);

const getOperator = (config: AppConfig): StellarSdk.Keypair => {
  if (!config.participantPolicyOperatorSecretKey) {
    throw new Error("PARTICIPANT_POLICY_OPERATOR_SECRET_KEY is not configured");
  }
  return StellarSdk.Keypair.fromSecret(config.participantPolicyOperatorSecretKey);
};

const submitGrantCall = async (
  config: AppConfig,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<{ hash: string; ledger: number }> => {
  const contractId = config.contracts.disclosureGrantRegistry;
  if (!contractId) throw new Error("DISCLOSURE_GRANT_REGISTRY_CONTRACT_ID is not configured");

  const operator = getOperator(config);
  const rpc = buildRpcServer(config);
  const source = await rpc.getAccount(operator.publicKey());
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
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, simulation).build();
  tx.sign(operator);

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
};

export const createDisclosureGrant = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    owner: string;
    viewerSecret: string;
    positionId: string;
    eventId: string;
    scope: DisclosureScope;
    scopedData: Record<string, unknown>;
    expiresAtLedger: number;
    auditorCiphertexts?: Record<string, unknown>;
    proof?: DisclosureBundlePlaintext["proof"];
    submitOnChain?: boolean;
  }
) => {
  const grantId = randomBytes(32).toString("hex");
  const vHash = viewerHash(input.viewerSecret);
  const sHash = scopeHash(input.scope);
  const eventHash = sha256Hex(input.eventId);
  const plaintext: DisclosureBundlePlaintext = {
    positionId: normalizeHex(input.positionId, "positionId"),
    scope: input.scope,
    scopedData: scopedOnly(input.scopedData, input.scope),
    ...(input.proof ? { proof: input.proof } : {}),
    ...(input.auditorCiphertexts ? { auditorCiphertexts: input.auditorCiphertexts } : {}),
    clientVerification: {
      expectedScopeHash: sHash
    }
  };
  const encrypted = encryptDisclosurePlaintext(plaintext, input.viewerSecret);
  const finalBundleHash = bundleHash(encrypted);

  insertDisclosureBundle(db, {
    id: newId("bundle"),
    grantId,
    owner: input.owner,
    viewerHash: vHash,
    positionId: normalizeHex(input.positionId, "positionId"),
    eventHash,
    scopeHash: sHash,
    bundleHash: finalBundleHash,
    ...encrypted,
    onChainTxHash: null,
    revoked: false,
    expiresAtLedger: input.expiresAtLedger
  });

  let onChain: { submitted: boolean; txHash?: string; ledger?: number; reason?: string } = {
    submitted: false,
    reason: "submitOnChain false"
  };
  if (input.submitOnChain !== false) {
    try {
      const tx = await submitGrantCall(config, "create_grant", [
        bytes32Arg(grantId, "grantId"),
        addressArg(input.owner),
        bytes32Arg(vHash, "viewerHash"),
        bytes32Arg(input.positionId, "positionId"),
        bytes32Arg(eventHash, "eventHash"),
        bytes32Arg(sHash, "scopeHash"),
        bytes32Arg(finalBundleHash, "bundleHash"),
        StellarSdk.nativeToScVal(input.expiresAtLedger, { type: "u32" }),
        addressArg(getOperator(config).publicKey())
      ]);
      updateDisclosureBundleOnChainTx(db, grantId, tx.hash);
      onChain = { submitted: true, txHash: tx.hash, ledger: tx.ledger };
    } catch (error) {
      onChain = {
        submitted: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    grantId,
    viewerSecret: input.viewerSecret,
    viewerHash: vHash,
    scopeHash: sHash,
    bundleHash: finalBundleHash,
    eventHash,
    expiresAtLedger: input.expiresAtLedger,
    onChain
  };
};

export const getDisclosureGrantBundle = async (
  config: AppConfig,
  db: AppDatabase,
  grantId: string
): Promise<{
  bundle: DisclosureBundleRecord;
  grantStatus: { revoked: boolean; expired: boolean; latestLedger: number | null };
}> => {
  const bundle = getDisclosureBundle(db, grantId);
  if (!bundle) throw new Error("disclosure_bundle_not_found");
  let latestLedger: number | null = null;
  try {
    const latest = await fetchLatestLedger(config.stellarRpcUrl);
    latestLedger = Number(latest.sequence ?? 0);
  } catch {
    latestLedger = null;
  }
  return {
    bundle,
    grantStatus: {
      revoked: bundle.revoked,
      expired: latestLedger === null ? false : latestLedger > bundle.expiresAtLedger,
      latestLedger
    }
  };
};

export const revokeDisclosureGrant = async (
  config: AppConfig,
  db: AppDatabase,
  grantId: string
) => {
  let onChain: { submitted: boolean; txHash?: string; ledger?: number; reason?: string };
  try {
    const tx = await submitGrantCall(config, "revoke_grant", [
      bytes32Arg(grantId, "grantId"),
      addressArg(getOperator(config).publicKey())
    ]);
    onChain = { submitted: true, txHash: tx.hash, ledger: tx.ledger };
  } catch (error) {
    onChain = {
      submitted: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  markDisclosureBundleRevoked(db, grantId);
  return { grantId, revoked: true, onChain };
};
