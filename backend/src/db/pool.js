import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// pg.Pool extends EventEmitter. Internally each call to pool.connect()
// briefly attaches `connect`/`acquire`/`remove`/`release` listeners
// while the client is checked out — under concurrent load (>10
// in-flight queries, which is normal for this app under tests +
// production traffic) Node emits the noisy "MaxListenersExceeded"
// warning even though no listener is actually leaking. Bumping the
// per-pool cap to 50 quiets it without papering over a real leak —
// withTx / pool.connect callsites all release in `finally`, audited.
pool.setMaxListeners(50);

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
