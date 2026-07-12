import * as StellarSdk from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const RPC_URL = "https://mainnet.sorobanrpc.com";
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;
const wasmPath = process.argv[2];

const secret = execSync("stellar keys secret mainnet-admin", { encoding: "utf8" }).trim();
const kp = StellarSdk.Keypair.fromSecret(secret);

const server = new StellarSdk.rpc.Server(RPC_URL);
const wasmBytes = readFileSync(wasmPath);
const account = await server.getAccount(kp.publicKey());

const op = StellarSdk.Operation.uploadContractWasm({ wasm: wasmBytes });
let tx = new StellarSdk.TransactionBuilder(account, { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE })
  .addOperation(op)
  .setTimeout(60)
  .build();

const sim = await server.simulateTransaction(tx);
if (StellarSdk.rpc.Api.isSimulationError(sim)) {
  console.log(JSON.stringify({ stage: "simulate", error: sim.error }));
  process.exit(1);
}
tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
tx.sign(kp);

console.log("submitting, hash:", tx.hash().toString("hex"));
const sendResult = await server.sendTransaction(tx);
console.log("send result status:", sendResult.status);

if (sendResult.status === "ERROR") {
  console.log("SEND ERROR, full result:", JSON.stringify(sendResult, null, 2));
  process.exit(1);
}

let status = sendResult.status;
let getResult;
for (let i = 0; i < 30 && (status === "PENDING" || status === "NOT_FOUND"); i++) {
  await new Promise(r => setTimeout(r, 2000));
  getResult = await server.getTransaction(sendResult.hash);
  status = getResult.status;
}
console.log("FINAL STATUS:", status);
console.log("WASM_HASH:", createHash("sha256").update(wasmBytes).digest("hex"));
if (status !== "SUCCESS") {
  console.log(JSON.stringify(getResult, (k,v)=>typeof v==='bigint'?v.toString():v));
}
