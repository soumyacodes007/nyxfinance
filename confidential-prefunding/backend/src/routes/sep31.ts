import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/sqlite.js";
import type { AppConfig } from "../lib/env.js";
import {
  createSep31Transaction,
  getSep31Transaction,
  markSep31Completed,
  markSep31PaymentSubmitted,
  updateSep31TransactionStatus
} from "../services/sep31.js";

const transactionSchema = z
  .object({
    id: z.string().min(1).optional(),
    transaction_id: z.string().min(1).optional(),
    anchor_transaction_id: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
    sender_id: z.string().min(1).optional(),
    receiver_id: z.string().min(1).optional(),
    status: z.string().optional(),
    stellar_transaction_id: z.string().nullable().optional(),
    amount_in: z.union([z.string(), z.number()]).nullable().optional(),
    amount_out: z.union([z.string(), z.number()]).nullable().optional(),
    asset_code: z.string().nullable().optional(),
    quote_id: z.string().nullable().optional(),
    fields: z.record(z.unknown()).optional()
  })
  .passthrough();

const transactionQuerySchema = z.object({
  id: z.string().min(1).optional(),
  transaction_id: z.string().min(1).optional()
});

const statusSchema = z
  .object({
    status: z.string().min(1)
  })
  .passthrough();

const path = (prefix: string, suffix: string) => `${prefix}${suffix}`;

export const registerSep31Routes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase,
  prefix = "/api/sep31"
): Promise<void> => {
  app.post(path(prefix, "/transactions"), async (request) =>
    createSep31Transaction(config, db, transactionSchema.parse(request.body))
  );

  app.get(path(prefix, "/transaction"), async (request, reply) => {
    const query = transactionQuerySchema.parse(request.query);
    const id = query.id ?? query.transaction_id;
    if (!id) return reply.code(400).send({ error: "id or transaction_id is required" });
    return getSep31Transaction(config, db, id);
  });

  app.get(path(prefix, "/transactions/:id"), async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return getSep31Transaction(config, db, params.id);
  });

  app.patch(path(prefix, "/transaction/:id/status"), async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = statusSchema.parse(request.body);
    return updateSep31TransactionStatus(config, db, params.id, body.status, body);
  });

  app.post(path(prefix, "/transaction/:id/submit-payment"), async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.record(z.unknown()).parse(request.body ?? {});
    return markSep31PaymentSubmitted(config, db, params.id, body);
  });

  app.post(path(prefix, "/transaction/:id/complete"), async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.record(z.unknown()).parse(request.body ?? {});
    return markSep31Completed(config, db, params.id, body);
  });
};
