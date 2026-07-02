import type { AppDatabase } from "../db/sqlite.js";
import { getSnapshot, upsertSnapshot } from "../db/sqlite.js";

export const snapshotCache = {
  getLastKnownGood<T>(db: AppDatabase, key: string) {
    return getSnapshot<T>(db, key);
  },
  putLastKnownGood(db: AppDatabase, key: string, payload: unknown, sourceStatus = "live") {
    upsertSnapshot(db, key, payload, sourceStatus);
  }
};
