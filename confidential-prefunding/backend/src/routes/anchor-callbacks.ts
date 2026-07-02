import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  recordAnchorTransactionCallback,
  recordCustomerStatus
} from "../services/anchor-platform.js";

const customerStatusSchema = z.object({
  customerId: z.string().min(1).optional(),
  customer_id: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  account: z.string().min(1),
  status: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(["accepted", "rejected", "pending", "needs_info"])),
  memo: z.string().nullable().optional(),
  reason: z.string().nullable().optional()
});

const transactionCallbackSchema = z.record(z.unknown());

export const registerAnchorCallbackRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/anchor/customer/status", async (request, reply) => {
    const body = customerStatusSchema.parse(request.body);
    const customerId = body.customerId ?? body.customer_id ?? body.id;
    if (!customerId) {
      return reply.code(400).send({ error: "customerId is required" });
    }
    const result = await recordCustomerStatus(config, db, {
      customerId,
      account: body.account,
      status: body.status,
      memo: body.memo ?? null,
      reason: body.reason ?? null,
      raw: request.body
    });
    return reply.send(result);
  });

  app.post("/api/anchor/transactions", async (request) => {
    const body = transactionCallbackSchema.parse(request.body);
    return recordAnchorTransactionCallback(db, body);
  });
};

export const registerBusinessCallbackRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.get("/health", async () => ({
    status: "ok",
    service: "business-server",
    timestamp: new Date().toISOString()
  }));

  app.post("/customer/status", async (request, reply) => {
    const body = customerStatusSchema.parse(request.body);
    const customerId = body.customerId ?? body.customer_id ?? body.id;
    if (!customerId) return reply.code(400).send({ error: "customerId is required" });
    return recordCustomerStatus(config, db, {
      customerId,
      account: body.account,
      status: body.status,
      memo: body.memo ?? null,
      reason: body.reason ?? null,
      raw: request.body
    });
  });

  app.post("/transactions", async (request) =>
    recordAnchorTransactionCallback(db, transactionCallbackSchema.parse(request.body))
  );

  app.post("/quotes", async (request) => ({
    accepted: true,
    service: "business-server",
    path: "/quotes",
    receivedAt: new Date().toISOString(),
    body: request.body
  }));

  app.all("/*", async (request) => ({
    accepted: true,
    service: "business-server",
    path: request.url,
    method: request.method,
    receivedAt: new Date().toISOString()
  }));
};
