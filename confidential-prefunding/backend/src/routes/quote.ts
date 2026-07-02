import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { createQuote } from "../services/quote-engine.js";

const quoteSchema = z.object({
  anchorTransactionId: z.string().optional(),
  account: z.string().min(1),
  collateralToken: z.string().optional(),
  requestedCreditAmount: z.string().regex(/^[0-9]+$/),
  tenorDays: z.number().int().positive().max(5)
});

export const registerQuoteRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  db: AppDatabase
): Promise<void> => {
  app.post("/api/prefunding/quote", async (request, reply) => {
    try {
      const quote = await createQuote(config, db, quoteSchema.parse(request.body));
      return reply.send(quote);
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
};
