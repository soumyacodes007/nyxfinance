import type { ProductStatus, SepStatus } from "./status.js";

export type CustomerStatus = "accepted" | "rejected" | "pending" | "needs_info";

export type AnchorCustomerStatusRequest = {
  customerId: string;
  account: string;
  status: CustomerStatus;
  memo?: string | null;
  reason?: string | null;
  raw?: unknown;
};

export type AnchorTransactionRecord = {
  id: string;
  anchorTransactionId: string;
  stellarTransactionId: string | null;
  account: string;
  sepStatus: SepStatus;
  productStatus: ProductStatus;
  amountIn: string | null;
  amountOut: string | null;
  assetCode: string | null;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
};
