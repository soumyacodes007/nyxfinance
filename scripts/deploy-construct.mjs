import * as StellarSdk from "@stellar/stellar-sdk";
import { execSync } from "node:child_process";

const RPC_URL = "https://mainnet.sorobanrpc.com";
const NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;
const wasmHashHex = process.argv[2];
const saltHex = process.argv[3];
const constructorArgsJson = process.argv[4];

const secret = execSync("stellar keys secret mainnet-admin", { encoding: "utf8" }).trim();
const kp = StellarSdk.Keypair.fromSecret(secret);
const server = new StellarSdk.rpc.Server(RPC_URL);
const account = await server.getAccount(kp.publicKey());

const argsSpec = JSON.parse(constructorArgsJson);
const scArgs = argsSpec.map(a => {
  if (a.type === "address") return StellarSdk.Address.fromString(a.value).toScVal();
  if (a.type === "u32") return StellarSdk.nativeToScVal(a.value, { type: "u32" });
  if (a.type === "bytes") return StellarSdk.nativeToScVal(Buffer.from(a.value, "hex"), { type: "bytes" });
  throw new Error("unsupported arg type " + a.type);
});

const op = StellarSdk.Operation.createCustomContract({
  address: StellarSdk.Address.fromString(kp.publicKey()),
  wasmHash: Buffer.from(wasmHashHex, "hex"),
  salt: Buffer.from(saltHex, "hex"),
  constructorArgs: scArgs
});

let tx = new StellarSdk.TransactionBuilder(account, { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE })
  .addOperation(op).setTimeout(60).build();

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
if (status === "SUCCESS") {
  const contractId = StellarSdk.StrKey.encodeContract(
    StellarSdk.Address.fromScAddress(getResult.returnValue.address()).toBuffer()
  );
  console.log("CONTRACT_ID:", contractId);
} else {
  console.log(JSON.stringify(getResult, (k,v)=>typeof v==='bigint'?v.toString():v));
}
