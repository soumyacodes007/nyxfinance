PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS proof_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS proof_jobs_status_created_idx
ON proof_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS watcher_state (
  name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  source_status TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchor_customers (
  customer_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  status TEXT NOT NULL,
  memo TEXT,
  reason TEXT,
  raw TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchor_transactions (
  id TEXT PRIMARY KEY,
  anchor_transaction_id TEXT NOT NULL UNIQUE,
  stellar_transaction_id TEXT,
  account TEXT NOT NULL,
  sep_status TEXT NOT NULL,
  product_status TEXT NOT NULL,
  amount_in TEXT,
  amount_out TEXT,
  asset_code TEXT,
  raw TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS anchor_transactions_status_idx
ON anchor_transactions(sep_status, product_status, updated_at);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  anchor_transaction_id TEXT,
  account TEXT NOT NULL,
  collateral_token TEXT NOT NULL,
  requested_credit_amount TEXT NOT NULL,
  tenor_days INTEGER NOT NULL,
  oracle_price_e7 TEXT NOT NULL,
  oracle_updated_ledger INTEGER,
  haircut_bps INTEGER NOT NULL,
  max_tenor_days INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL,
  fee_amount TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  ledger INTEGER,
  paging_token TEXT,
  tx_hash TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contract_events_unique_idx
ON contract_events(contract_id, event_name, COALESCE(tx_hash, ''), COALESCE(paging_token, ''));

CREATE TABLE IF NOT EXISTS confidential_transfer_evidence (
  id TEXT PRIMARY KEY,
  anchor_transaction_id TEXT,
  position_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  token_contract_id TEXT NOT NULL,
  method TEXT NOT NULL,
  signer TEXT NOT NULL,
  spender TEXT,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  transfer_commitment TEXT,
  tx_hash TEXT NOT NULL,
  ledger INTEGER,
  auditor_payload TEXT,
  event_payload TEXT NOT NULL,
  data_xdr_sha256 TEXT NOT NULL,
  data_xdr_base64 TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS confidential_transfer_evidence_position_idx
ON confidential_transfer_evidence(position_id, created_at);

CREATE TABLE IF NOT EXISTS repayment_leaves (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  leaf_nullifier TEXT NOT NULL UNIQUE,
  repayment_commitment TEXT NOT NULL,
  paid_ledger INTEGER NOT NULL,
  due_ledger INTEGER NOT NULL,
  on_time INTEGER NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disclosure_bundles (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  viewer_hash TEXT NOT NULL,
  position_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  on_chain_tx_hash TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at_ledger INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS disclosure_bundles_position_idx
ON disclosure_bundles(position_id, created_at);
