import * as StellarSdk from "@stellar/stellar-sdk";
import { execSync } from "node:child_process";

const RPC_URL = "https://mainnet.sorobanrpc.com";
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;
const contractId = process.argv[2];
const policyAddress = process.argv[3];

const secret = execSync("stellar keys secret mainnet-admin", { encoding: "utf8" }).trim();
const kp = StellarSdk.Keypair.fromSecret(secret);
const server = new StellarSdk.rpc.Server(RPC_URL);
const account = await server.getAccount(kp.publicKey());

const configVal = StellarSdk.xdr.ScVal.scvMap([
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol("policy"),
    val: StellarSdk.Address.fromString(policyAddress).toScVal()
  }),
  new StellarSdk.xdr.ScMapEntry({
    key: StellarSdk.xdr.ScVal.scvSymbol("sac_passthrough"),
    val: StellarSdk.xdr.ScVal.scvBool(false)
  })
]);

const contract = new StellarSdk.Contract(contractId);
const operatorArg = StellarSdk.Address.fromString(kp.publicKey()).toScVal();

let tx = new StellarSdk.TransactionBuilder(account, { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE })
  .addOperation(contract.call("set_compliance_config", configVal, operatorArg))
  .setTimeout(60).build();

const sim = await server.simulateTransaction(tx);
if (StellarSdk.rpc.Api.isSimulationError(sim)) {
  console.log(JSON.stringify({ stage: "simulate", error: sim.error }));
  process.exit(1);
}
tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
tx.sign(kp);

const sendResult = await server.sendTransaction(tx);
console.log("submitted, hash:", sendResult.hash, "status:", sendResult.status);
if (sendResult.status === "ERROR") {
  console.log(JSON.stringify(sendResult, null, 2));
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
if (status !== "SUCCESS") {
  console.log(JSON.stringify(getResult, (k,v)=>typeof v==='bigint'?v.toString():v));
}
