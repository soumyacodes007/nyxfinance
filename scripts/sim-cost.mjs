import * as StellarSdk from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
const server = new StellarSdk.rpc.Server("https://mainnet.sorobanrpc.com");
const wasmPath = process.argv[2];
const wasmBytes = readFileSync(wasmPath);
const account = await server.getAccount("GDS7Y6GA6VIGVKBMBQ6JGOLMTNPTHGJRQSCQBTBL5WLEBPPFU3C44NC4");
const op = StellarSdk.Operation.uploadContractWasm({ wasm: wasmBytes });
const tx = new StellarSdk.TransactionBuilder(account, { fee: StellarSdk.BASE_FEE, networkPassphrase: StellarSdk.Networks.PUBLIC })
  .addOperation(op).setTimeout(30).build();
const sim = await server.simulateTransaction(tx);
if (StellarSdk.rpc.Api.isSimulationError(sim)) {
  console.log(JSON.stringify({ error: sim.error }));
} else {
  console.log("feeXLM:", (Number(sim.minResourceFee)/10_000_000).toFixed(4));
}
