import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { listConfidentialTransferEvidence } from "../db/sqlite.js";
import {
  createDisclosureGrant,
  getDisclosureGrantBundle,
  revokeDisclosureGrant
} from "../services/disclosure.js";

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);

const scopeSchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
  label: z.string().optional()
});

const proofSchema = z.object({
  type: z.string().min(1),
  publicInputsHex: z.string().regex(/^(0x)?[0-9a-fA-F]+$/),
  proofHex: z.string().regex(/^(0x)?[0-9a-fA-F]+$/)
});

const createDisclosureSchema = z.object({
  owner: z.string().min(1),
  viewerSecret: z.string().min(16),
  positionId: hex32,
  eventId: z.string().min(1),
  scope: scopeSchema,
  scopedData: z.record(z.unknown()),
  expiresAtLedger: z.number().int().positive(),
  auditorCiphertexts: z.record(z.unknown()).optional(),
  proof: proofSchema.optional(),
  submitOnChain: z.boolean().optional()
});

const liveAuditorEventsQuery = z.object({
  positionId: hex32.optional(),
  anchorTransactionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

export const registerDisclosureRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/disclosure/grants", async (request, reply) => {
    try {
      return await createDisclosureGrant(config, db, createDisclosureSchema.parse(request.body));
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/auditor/live-events", async (request) => {
    const query = liveAuditorEventsQuery.parse(request.query);
    const events = listConfidentialTransferEvidence(db, query).map((event) => ({
      id: event.id,
      anchorTransactionId: event.anchorTransactionId,
      positionId: event.positionId,
      direction: event.direction,
      tokenContractId: event.tokenContractId,
      method: event.method,
      signer: event.signer,
      spender: event.spender,
      from: event.fromAccount,
      to: event.toAccount,
      transferCommitment: event.transferCommitment,
      txHash: event.txHash,
      ledger: event.ledger,
      dataXdrSha256: event.dataXdrSha256,
      dataXdrBase64Available: Boolean(event.dataXdrBase64),
      auditorPayload: event.auditorPayload,
      eventPayload: event.eventPayload,
      createdAt: event.createdAt
    }));
    return {
      plaintextAmountsIncluded: false,
      decryptClientSide: true,
      events
    };
  });

  app.get("/api/disclosure/:grantId", async (request, reply) => {
    try {
      const params = z.object({ grantId: hex32 }).parse(request.params);
      const { bundle, grantStatus } = await getDisclosureGrantBundle(config, db, params.grantId);
      return {
        grant: {
          grantId: bundle.grantId,
          owner: bundle.owner,
          viewerHash: bundle.viewerHash,
          positionId: bundle.positionId,
          eventHash: bundle.eventHash,
          scopeHash: bundle.scopeHash,
          bundleHash: bundle.bundleHash,
          expiresAtLedger: bundle.expiresAtLedger,
          onChainTxHash: bundle.onChainTxHash,
          revoked: bundle.revoked
        },
        encryptedBundle: {
          ciphertext: bundle.ciphertext,
          nonce: bundle.nonce,
          authTag: bundle.authTag,
          algorithm: bundle.algorithm
        },
        grantStatus
      };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/disclosure/:grantId/revoke", async (request, reply) => {
    try {
      const params = z.object({ grantId: hex32 }).parse(request.params);
      return await revokeDisclosureGrant(config, db, params.grantId);
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
