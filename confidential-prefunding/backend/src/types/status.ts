export type SepStatus =
  | "pending_sender"
  | "pending_stellar"
  | "pending_receiver"
  | "pending_external"
  | "completed"
  | "refunded"
  | "expired"
  | "error";

export type ProductStatus =
  | "prefunding_required"
  | "credit_quote_ready"
  | "proof_pending"
  | "proof_verified"
  | "credit_drawn"
  | "repaid"
  | "defaulted"
  | "closed";

export const sepStatuses = [
  "pending_sender",
  "pending_stellar",
  "pending_receiver",
  "pending_external",
  "completed",
  "refunded",
  "expired",
  "error"
] as const;

export const productStatuses = [
  "prefunding_required",
  "credit_quote_ready",
  "proof_pending",
  "proof_verified",
  "credit_drawn",
  "repaid",
  "defaulted",
  "closed"
] as const;
