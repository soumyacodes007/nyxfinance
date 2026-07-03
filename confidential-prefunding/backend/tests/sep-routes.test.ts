import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApi } from "../src/app.js";
import { openAppDatabase } from "../src/db/sqlite.js";
import type { AppConfig } from "../src/lib/env.js";

const config = {
  stellarRpcUrl: "https://rpc.example.test",
  stellarHorizonUrl: "https://horizon.example.test",
  stellarNetworkPassphrase: "Test SDF Network ; September 2015",
  anchorStellarTomlUrl: "https://anchor.example.test/.well-known/stellar.toml",
  anchorPlatformPublicUrl: "http://localhost:8080",
  hostSep10Account: "HOST",
  distributionAccount: "DIST",
  demoAnchorAccount: "ANCHOR",
  appStateDbPath: "unused",
  apiPort: 3001,
  businessServerPort: 8091,
  frontendPort: 3000,
  friendbotUrl: "https://friendbot.stellar.org",
  anchorPlatformUrl: "http://anchor-platform:8080",
  frontendApiBaseUrl: "http://api:3001",
  prefundingFeeBps: 35,
  watcherPollIntervalMs: 15000,
  proverPollIntervalMs: 5000,
  ozConfidentialRoot: "./oz-confidential",
  oracleMode: "mock",
  oracleSource: "demo_adapter",
  reflectorPulseContractId: "CREFLECTOR",
  reflectorBaseAsset: "USDC",
  reflectorQuoteAsset: "USDC",
  reflectorStalenessSeconds: 900,
  proverMode: "alpha_demo_prover_worker",
  demoAccounts: {
    alpha: "GALPHA",
    facility: "GFACILITY",
    auditor: "GAUDITOR"
  },
  demoAnchorSecretKey: null,
  participantPolicyOperatorSecretKey: null,
  creditExecutorSecretKey: null,
  requireConfidentialRepaymentTransfer: false,
  contracts: {
    participantPolicy: "CPOLICY",
    collateralPolicy: "CCOLLATERAL",
    oracleAdapter: "CORACLE",
    collateralLock: "CLOCK",
    prefundingCreditLine: "CCREDIT",
    collateralSufficiencyVerifier: "CVERIFY",
    collateralToken: "CTOKEN",
    confidentialCusdc: "CCUSDC",
    disclosureGrantRegistry: null,
    repaymentHistory: null,
    repaymentHistoryVerifier: null
  }
} satisfies AppConfig;

test("SEP-12 stores customer status and returns SEP-shaped KYC status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prefunding-sep12-"));
  const db = openAppDatabase(join(dir, "app.sqlite"));
  const app = await buildApi(config, db);

  const put = await app.inject({
    method: "PUT",
    url: "/api/sep12/customer",
    payload: {
      id: "cust-alpha",
      account: "GALPHA",
      type: "sep31-sender",
      status: "PROCESSING",
      fields: { email_address: "alpha@example.test" }
    }
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().status, "PROCESSING");

  const get = await app.inject({
    method: "GET",
    url: "/api/sep12/customer?id=cust-alpha"
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().id, "cust-alpha");
  assert.equal(get.json().status, "PROCESSING");
  assert.deepEqual(get.json().provided_fields, { email_address: "alpha@example.test" });

  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("SEP-31 creates and updates transactions without overwriting product state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prefunding-sep31-"));
  const db = openAppDatabase(join(dir, "app.sqlite"));
  const app = await buildApi(config, db);

  const create = await app.inject({
    method: "POST",
    url: "/api/sep31/transactions",
    payload: {
      id: "tx-alpha-1",
      sender_id: "GALPHA",
      receiver_id: "GFACILITY",
      amount_in: "1000.00",
      amount_out: "995.00",
      asset_code: "USDC"
    }
  });
  assert.equal(create.statusCode, 200);
  assert.equal(create.json().status, "pending_sender");
  assert.equal(create.json().product_status, "prefunding_required");

  const submitted = await app.inject({
    method: "POST",
    url: "/api/sep31/transaction/tx-alpha-1/submit-payment",
    payload: {
      stellar_transaction_id: "draw-tx"
    }
  });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().status, "pending_stellar");
  assert.equal(submitted.json().product_status, "prefunding_required");
  assert.equal(submitted.json().stellar_transaction_id, "draw-tx");

  const completed = await app.inject({
    method: "POST",
    url: "/api/sep31/transaction/tx-alpha-1/complete",
    payload: {
      settlement_transaction_id: "settle-tx"
    }
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().status, "completed");
  assert.equal(completed.json().product_status, "prefunding_required");

  const get = await app.inject({
    method: "GET",
    url: "/api/sep31/transaction?id=tx-alpha-1"
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().more_info_url, "http://localhost:8080/sep31/transaction/tx-alpha-1");

  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("demo-flow exposes UI state and refuses to fake draw before open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prefunding-demo-flow-"));
  const db = openAppDatabase(join(dir, "app.sqlite"));
  const app = await buildApi(config, db);

  const state = await app.inject({
    method: "GET",
    url: "/api/demo-flow/state"
  });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().state.positionId, null);
  assert.equal(state.json().state.historyProof, null);
  assert.equal(typeof state.json().artifactStatus.drawTransferDataXdrConfigured, "boolean");

  const draw = await app.inject({
    method: "POST",
    url: "/api/demo-flow/draw",
    payload: {}
  });
  assert.equal(draw.statusCode, 422);
  assert.match(draw.json().error, /No opened demo position/);

  const historyProof = await app.inject({
    method: "POST",
    url: "/api/demo-flow/history-proof",
    payload: {}
  });
  assert.equal(historyProof.statusCode, 422);
  assert.match(historyProof.json().error, /No opened demo position/);

  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("demo-flow bootstrap seeds default SEP-31 and SEP-12 state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prefunding-demo-bootstrap-"));
  const db = openAppDatabase(join(dir, "app.sqlite"));
  const app = await buildApi(config, db);

  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/demo-flow/bootstrap",
    payload: {
      anchorTransactionId: "sep31-alpha-001",
      account: "GALPHA",
      kybStatus: "ACCEPTED"
    }
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.json().transaction.id, "sep31-alpha-001");
  assert.equal(bootstrap.json().transaction.status, "pending_sender");
  assert.equal(bootstrap.json().customer.status, "ACCEPTED");
  assert.equal(bootstrap.json().demoReady.sep31Seeded, true);

  const tx = await app.inject({
    method: "GET",
    url: "/api/sep31/transaction?id=sep31-alpha-001"
  });
  assert.equal(tx.statusCode, 200);
  assert.equal(tx.json().status, "pending_sender");
  assert.equal(tx.json().product_status, "prefunding_required");

  const customer = await app.inject({
    method: "GET",
    url: "/api/sep12/customer?account=GALPHA&type=sep31-sender"
  });
  assert.equal(customer.statusCode, 200);
  assert.equal(customer.json().status, "ACCEPTED");

  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("auditor decrypt endpoint validates ciphertext payload before running tooling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prefunding-auditor-decrypt-"));
  const db = openAppDatabase(join(dir, "app.sqlite"));
  const app = await buildApi(config, db);

  const missing = await app.inject({
    method: "POST",
    url: "/api/auditor/decrypt",
    payload: {
      auditorPayload: {
        r_e: "00"
      }
    }
  });
  assert.equal(missing.statusCode, 422);
  assert.match(missing.json().error, /missing v_aud_r/);

  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
