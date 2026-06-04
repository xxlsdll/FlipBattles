/**
 * db.js
 * -----
 * Postgres data layer for player balances + inventory. Connects using the
 * DATABASE_URL that Railway injects when you add a Postgres service.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Uncomment ONLY if you connect over the PUBLIC proxy URL instead of the
  // internal one (postgres.railway.internal needs no SSL):
  // ssl: { rejectUnauthorized: false },
});

// Create the table if needed and make sure the inventory column exists.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id    BIGINT PRIMARY KEY,
      tokens     BIGINT NOT NULL DEFAULT 0,
      inventory  JSONB  NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // The table you created by hand earlier had no inventory column -- this adds
  // it without touching existing rows. No-op once the column exists.
  await pool.query(
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS inventory JSONB NOT NULL DEFAULT '[]'::jsonb;`
  );
  console.log("[db] players table ready");
}

// Returns { tokens, inventory } or null if the player has no row yet.
async function getPlayer(userId) {
  const { rows } = await pool.query(
    "SELECT tokens, inventory FROM players WHERE user_id = $1",
    [userId]
  );
  if (!rows.length) return null;
  return { tokens: Number(rows[0].tokens), inventory: rows[0].inventory };
}

// Absolute save. tokens is always written. inventory is written ONLY when an
// array is actually passed -- passing undefined/null leaves the stored
// inventory untouched, so a tokens-only autosave can never wipe a player's
// items. (This is the key change from the version you pasted.)
async function setPlayer(userId, tokens, inventory) {
  const t = Math.trunc(Number(tokens));

  if (inventory === undefined || inventory === null) {
    const { rows } = await pool.query(
      `INSERT INTO players (user_id, tokens) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET tokens = EXCLUDED.tokens, updated_at = now()
       RETURNING tokens, inventory`,
      [userId, t]
    );
    return { tokens: Number(rows[0].tokens), inventory: rows[0].inventory };
  }

  const { rows } = await pool.query(
    `INSERT INTO players (user_id, tokens, inventory) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET tokens = EXCLUDED.tokens, inventory = EXCLUDED.inventory, updated_at = now()
     RETURNING tokens, inventory`,
    [userId, t, JSON.stringify(inventory)]
  );
  return { tokens: Number(rows[0].tokens), inventory: rows[0].inventory };
}

// Atomic token add/spend. allowNegative:false rejects an overspend.
// Returns { ok:true, tokens } or { ok:false, reason:"insufficient", tokens }.
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
    const next = current + Math.trunc(delta);
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

// Atomic purchase: deduct price AND append the item in ONE transaction.
// Returns { ok:true, tokens, inventory } or { ok:false, reason:"insufficient", tokens }.
async function purchase(userId, price, item) {
  price = Math.trunc(price);
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
    if (current < price) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const upd = await client.query(
      `UPDATE players
         SET tokens = tokens - $2, inventory = inventory || $3::jsonb, updated_at = now()
       WHERE user_id = $1
       RETURNING tokens, inventory`,
      [userId, price, JSON.stringify(item)]
    );
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens), inventory: upd.rows[0].inventory };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Read-only inventory list (empty array if no row). For your website/dashboard.
async function getInventory(userId) {
  const { rows } = await pool.query(
    "SELECT inventory FROM players WHERE user_id = $1",
    [userId]
  );
  return rows.length ? rows[0].inventory : [];
}

module.exports = { init, getPlayer, setPlayer, addTokens, purchase, getInventory, pool };
