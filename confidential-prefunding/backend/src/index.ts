import { buildApi } from "./app.js";
import { openAppDatabase } from "./db/sqlite.js";
import { config } from "./lib/env.js";

const db = openAppDatabase(config.appStateDbPath);
const app = await buildApi(config, db);

await app.listen({ port: config.apiPort, host: "0.0.0.0" });
