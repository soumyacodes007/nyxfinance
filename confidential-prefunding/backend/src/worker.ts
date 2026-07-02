import { openAppDatabase } from "./db/sqlite.js";
import { config } from "./lib/env.js";
import { processNextProofJob } from "./services/prover-worker.js";
import { syncWatcherOnce } from "./services/watcher.js";

const db = openAppDatabase(config.appStateDbPath);

const runProofLoop = async () => {
  try {
    const job = await processNextProofJob(config, db);
    if (job) {
      console.log(JSON.stringify({ service: "prover-worker", processedJob: job.id }));
    }
  } catch (error) {
    console.error(JSON.stringify({ service: "prover-worker", error: String(error) }));
  } finally {
    setTimeout(runProofLoop, config.proverPollIntervalMs);
  }
};

const runWatcherLoop = async () => {
  try {
    const result = await syncWatcherOnce(config, db);
    console.log(JSON.stringify({ service: "watcher", result }));
  } catch (error) {
    console.error(JSON.stringify({ service: "watcher", error: String(error) }));
  } finally {
    setTimeout(runWatcherLoop, config.watcherPollIntervalMs);
  }
};

runProofLoop();
runWatcherLoop();
