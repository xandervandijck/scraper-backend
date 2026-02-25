/**
 * PostgreSQL connection pool (Neon serverless compatible).
 */
import pkg from 'pg';
const { Pool } = pkg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/** Execute a parameterised query. */
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const dur = Date.now() - start;
    if (dur > 1000) console.warn(`[DB] Slow query (${dur}ms):`, text.slice(0, 80));
    return res;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nSQL:', text.slice(0, 100));
    throw err;
  }
}

/** Run multiple queries in a single transaction. fn receives the client. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { pool };
export default { query, withTransaction, pool };
