/**
 * db.js
 * -----
 * Postgres data layer for player balances. Connects using the DATABASE_URL
 * that Railway injects when you add a Postgres service to your project.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal connections (postgres.railway.internal) don't need SSL.
  // If you ever connect over the PUBLIC proxy URL instead, uncomment this:
  // ssl: { rejectUnauthorized: false },
});

// Create the table if it doesn't exist. Called once at startup.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id    BIGINT PRIMARY KEY,
      tokens     BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("[db] players table ready");
}

// Returns the balance as a number, or null if the player has no row yet.
async function getTokens(userId) {
  const { rows } = await pool.query(
    "SELECT tokens FROM players WHERE user_id = $1",
    [userId]
  );
  return rows.length ? Number(rows[0].tokens) : null;
}

// Set an absolute balance (upsert). Use for session saves.
async function setTokens(userId, amount) {
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, tokens) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET tokens = $2, updated_at = now()
     RETURNING tokens`,
    [userId, amount]
  );
  return Number(rows[0].tokens);
}

// Atomically add (or subtract) tokens. Set allowNegative=false to reject a
// change that would drop the balance below zero (e.g. a purchase).
// Returns { ok: true, tokens } or { ok: false, reason: "insufficient", tokens }.
async function addTokens(userId, delta, allowNegative = true) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING",
      [userId]
    );
    const { rows } = await client.query(
      "SELECT tokens FROM players WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    const current = Number(rows[0].tokens);
    const next = current + delta;
    if (!allowNegative && next < 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const upd = await client.query(
      "UPDATE players SET tokens = $2, updated_at = now() WHERE user_id = $1 RETURNING tokens",
      [userId, next]
    );
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { init, getTokens, setTokens, addTokens };
