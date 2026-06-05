/**
 * db.js
 * -----
 * Postgres data layer: player tokens + inventory, atomic add/purchase, and
 * battle logging/history. Connects using the DATABASE_URL Railway injects.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false }, // only if using the PUBLIC proxy URL
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id    BIGINT PRIMARY KEY,
      tokens     BIGINT NOT NULL DEFAULT 0,
      inventory  JSONB  NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Safe to run on an existing tokens-only table:
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS inventory JSONB NOT NULL DEFAULT '[]'::jsonb;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS battles (
      id           TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      initiator    BIGINT,
      winner       BIGINT,
      total_value  BIGINT,
      participants BIGINT[] NOT NULL DEFAULT '{}',
      data         JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS battles_created_idx ON battles (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS battles_participants_idx ON battles USING GIN (participants);`);

  console.log("[db] tables ready");
}

/* ---------------- Players ---------------- */

async function getPlayer(userId) {
  const { rows } = await pool.query("SELECT tokens, inventory FROM players WHERE user_id = $1", [userId]);
  return rows.length ? { tokens: Number(rows[0].tokens), inventory: rows[0].inventory } : null;
}

// Partial update: only the fields you pass are changed. Omitted fields keep
// their existing value (so a token-only save can't wipe the inventory).
async function setPlayer(userId, tokens, inventory) {
  const tokParam = tokens === undefined || tokens === null ? null : Math.trunc(tokens);
  const invParam = inventory === undefined || inventory === null ? null : JSON.stringify(inventory);
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, tokens, inventory)
       VALUES ($1, COALESCE($2::bigint, 0), COALESCE($3::jsonb, '[]'::jsonb))
     ON CONFLICT (user_id) DO UPDATE
       SET tokens     = COALESCE($2::bigint, players.tokens),
           inventory  = COALESCE($3::jsonb, players.inventory),
           updated_at = now()
     RETURNING tokens, inventory`,
    [userId, tokParam, invParam]
  );
  return { tokens: Number(rows[0].tokens), inventory: rows[0].inventory };
}

async function getInventory(userId) {
  const { rows } = await pool.query("SELECT inventory FROM players WHERE user_id = $1", [userId]);
  return rows.length ? rows[0].inventory : [];
}

async function addTokens(userId, delta, allowNegative = true) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const { rows } = await client.query("SELECT tokens FROM players WHERE user_id = $1 FOR UPDATE", [userId]);
    const current = Number(rows[0].tokens);
    const next = current + Math.trunc(delta);
    if (!allowNegative && next < 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const upd = await client.query(
      "UPDATE players SET tokens = $2, updated_at = now() WHERE user_id = $1 RETURNING tokens", [userId, next]);
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomic purchase: deduct price AND append item in one transaction.
async function purchase(userId, price, item) {
  price = Math.trunc(price);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const { rows } = await client.query("SELECT tokens FROM players WHERE user_id = $1 FOR UPDATE", [userId]);
    const current = Number(rows[0].tokens);
    if (current < price) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const upd = await client.query(
      `UPDATE players SET tokens = tokens - $2, inventory = inventory || $3::jsonb, updated_at = now()
       WHERE user_id = $1 RETURNING tokens, inventory`,
      [userId, price, JSON.stringify(item)]
    );
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens), inventory: upd.rows[0].inventory };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomically append item(s) to a player's inventory. Works whether or not the
// player is online (no loaded profile needed) -- used for offline winners and
// offline refunds. `items` is an ARRAY of item objects.
async function grantItems(userId, items) {
  const list = Array.isArray(items) ? items : [];
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, tokens, inventory) VALUES ($1, 0, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET inventory = players.inventory || $2::jsonb, updated_at = now()
     RETURNING inventory`,
    [userId, JSON.stringify(list)]
  );
  return { ok: true, inventory: rows[0].inventory };
}

/* ---------------- Battles ---------------- */

async function saveBattle(record) {
  const participants = Array.isArray(record.players)
    ? record.players.map((p) => p.userId).filter((v) => v != null)
    : [];
  await pool.query(
    `INSERT INTO battles (id, status, initiator, winner, total_value, participants, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE
       SET status=$2, initiator=$3, winner=$4, total_value=$5,
           participants=$6, data=$7, updated_at=now()`,
    [record.id, record.status, record.initiator ?? null, record.winner ?? null,
     record.totalValue ?? null, participants, JSON.stringify(record)]
  );
  return { ok: true };
}

async function getBattle(id) {
  const { rows } = await pool.query("SELECT data, created_at, updated_at FROM battles WHERE id=$1", [id]);
  if (!rows.length) return null;
  return { ...rows[0].data, created_at: rows[0].created_at, updated_at: rows[0].updated_at };
}

function clampLimit(limit) { return Math.min(Math.max(parseInt(limit) || 50, 1), 200); }

async function recentBattles(limit) {
  const { rows } = await pool.query("SELECT data FROM battles ORDER BY created_at DESC LIMIT $1", [clampLimit(limit)]);
  return rows.map((r) => r.data);
}

async function playerBattles(userId, limit) {
  const { rows } = await pool.query(
    "SELECT data FROM battles WHERE $1 = ANY(participants) ORDER BY created_at DESC LIMIT $2",
    [userId, clampLimit(limit)]
  );
  return rows.map((r) => r.data);
}

module.exports = {
  init, getPlayer, setPlayer, getInventory, addTokens, purchase, grantItems,
  saveBattle, getBattle, recentBattles, playerBattles, pool,
};
