import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  getConfidentialTransferEvidenceById,
  updateConfidentialTransferEvidence,
  type ConfidentialTransferEvidence
} from "../db/sqlite.js";
import { decryptAuditorPayload, inspectTransferDataXdr } from "../services/auditor-decrypt.js";
import { fetchEmittedConfidentialEventPayload } from "../services/confidential-token-transfer.js";

const hexValue = z.string().regex(/^(0x)?[0-9a-fA-F]+$/);

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
};

const getString = (
  source: Record<string, unknown>,
  names: string[],
  required = true
): string | undefined => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  if (required) throw new Error(`missing ${names[0]}`);
  return undefined;
};

const mergeDefined = (...sources: Record<string, unknown>[]): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null && value !== "") merged[key] = value;
    }
  }
  return merged;
};

const optionalRecord = (source: Record<string, unknown>, name: string): Record<string, unknown> => {
  const value = source[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const configured = (value: string | undefined): value is string =>
  Boolean(value && value !== "REPLACE_ME" && !value.startsWith("TODO_"));

const fallbackDataXdrForEvidence = (
  evidence: ConfidentialTransferEvidence | null
): string | undefined => {
  if (!evidence) return undefined;
  const envName =
    evidence.direction === "draw"
      ? "DRAW_TRANSFER_DATA_XDR_BASE64"
      : "REPAYMENT_TRANSFER_DATA_XDR_BASE64";
  const value = process.env[envName];
  return configured(value) ? value : undefined;
};

const fallbackAuditorPayloadForEvidence = (
  evidence: ConfidentialTransferEvidence | null
): Record<string, unknown> | null => {
  if (!evidence) return null;
  const envName =
    evidence.direction === "draw" ? "DRAW_AUDITOR_PAYLOAD_JSON" : "REPAYMENT_AUDITOR_PAYLOAD_JSON";
  const value = process.env[envName];
  if (!configured(value)) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const eventNameForEvidence = (
  evidence: ConfidentialTransferEvidence
): "transfer" | "spender_transfer" =>
  evidence.method === "confidential_transfer_from" ? "spender_transfer" : "transfer";

const hasDecryptSalt = (payload: Record<string, unknown>): boolean =>
  typeof payload.sigma === "string" || typeof payload.sigma_a === "string";

const hydrateEvidence = async (
  config: AppConfig,
  db: AppDatabase,
  evidence: ConfidentialTransferEvidence | null,
  rawDataXdrBase64?: string
): Promise<ConfidentialTransferEvidence | null> => {
  if (!evidence) return null;
  const fallbackDataXdrBase64 = rawDataXdrBase64 ?? evidence.dataXdrBase64 ?? fallbackDataXdrForEvidence(evidence);
  const fallbackAuditorPayload = fallbackAuditorPayloadForEvidence(evidence);
  const shouldFetchEventPayload = !hasDecryptSalt(evidence.eventPayload);
  let eventPayload = evidence.eventPayload;
  const auditorPayload = mergeDefined(fallbackAuditorPayload ?? {}, evidence.auditorPayload ?? {});

  if (shouldFetchEventPayload) {
    const fetched = await fetchEmittedConfidentialEventPayload(config, {
      tokenContractId: evidence.tokenContractId,
      txHash: evidence.txHash,
      ledger: evidence.ledger ?? undefined,
      eventName: eventNameForEvidence(evidence)
    }).catch((error) => ({
      emittedEventBackfillError: error instanceof Error ? error.message : String(error)
    }));
    eventPayload = mergeDefined(eventPayload, fetched ?? {});
  }

  if (
    fallbackDataXdrBase64 !== evidence.dataXdrBase64 ||
    eventPayload !== evidence.eventPayload ||
    JSON.stringify(auditorPayload) !== JSON.stringify(evidence.auditorPayload ?? {})
  ) {
    return updateConfidentialTransferEvidence(db, evidence.id, {
      auditorPayload,
      dataXdrBase64: fallbackDataXdrBase64 ?? evidence.dataXdrBase64,
      eventPayload
    });
  }
  return evidence;
};

const parseDecryptRequest = async (config: AppConfig, db: AppDatabase, body: unknown) => {
  const raw = asRecord(body);
  const evidenceId = getString(raw, ["evidenceId", "eventId"], false);
  const storedEvidence = evidenceId ? getConfidentialTransferEvidenceById(db, evidenceId) : null;
  const rawDataXdrBase64 = getString(raw, ["dataXdrBase64"], false);
  const evidence = await hydrateEvidence(config, db, storedEvidence, rawDataXdrBase64);
  if (evidenceId && !evidence) throw new Error(`auditor evidence not found: ${evidenceId}`);

  const rawPayload = optionalRecord(raw, "auditorPayload");
  const rawEventPayload = optionalRecord(raw, "eventPayload");
  const dataXdrBase64 = rawDataXdrBase64 ?? evidence?.dataXdrBase64 ?? undefined;
  const inspected = dataXdrBase64 ? inspectTransferDataXdr(config, dataXdrBase64) : null;
  const xdrPayload =
    inspected?.kind === "confidential_transfer"
      ? {
          r_e: inspected.r_e,
          sigma: inspected.sigma,
          v_aud_r: inspected.v_aud_r,
          r_aud_r: inspected.r_aud_r,
          v_aud_s: inspected.v_aud_s,
          b_aud_s: inspected.b_aud_s
        }
      : inspected
        ? {
            r_e: inspected.r_e,
            v_aud_r: inspected.v_aud_r,
            r_aud_r: inspected.r_aud_r,
            v_aud_s: inspected.v_aud_s,
            a_aud_s: inspected.a_aud_s
          }
        : {};
  const payload = mergeDefined(
    xdrPayload,
    evidence?.eventPayload ?? {},
    evidence?.auditorPayload ?? {},
    raw,
    rawEventPayload,
    rawPayload,
    { secret: raw.secret }
  );

  const parsed = {
    rE: getString(payload, ["r_e", "rE", "r_e_hex"]),
    vAudR: getString(payload, ["v_aud_r", "vAudR"]),
    sigma: getString(payload, ["sigma", "sigma_a"], false),
    secret: getString(payload, ["secret", "auditorSecret"], false),
    rAudR: getString(payload, ["r_aud_r", "rAudR"], false),
    vAudS: getString(payload, ["v_aud_s", "vAudS"], false),
    bAudS: getString(payload, ["b_aud_s", "bAudS", "a_aud_s", "aAudS"], false)
  };
  if (!parsed.sigma && inspected?.kind === "confidential_transfer_from") {
    throw new Error(
      "missing sigma; spender transfer decrypt requires emitted sigma_a from the live spender_transfer event"
    );
  }
  if (!parsed.sigma) throw new Error("missing sigma");

  z.object({
    rE: hexValue,
    vAudR: hexValue,
    sigma: hexValue,
    secret: z.string().min(1).optional(),
    rAudR: hexValue.optional(),
    vAudS: hexValue.optional(),
    bAudS: hexValue.optional()
  }).parse(parsed);

  return parsed as {
    rE: string;
    vAudR: string;
    sigma: string;
    secret?: string;
    rAudR?: string;
    vAudS?: string;
    bAudS?: string;
  };
};

export const registerAuditorRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/auditor/decrypt", async (request, reply) => {
    try {
      const input = await parseDecryptRequest(config, db, request.body);
      return decryptAuditorPayload(config, input);
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
