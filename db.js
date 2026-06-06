/**
 * db.js
 * -----
 * Postgres data layer: player tokens + inventory, atomic add/purchase, daily
 * rewards, battle logging/history, and the house bot (tokens/inventory + a
 * server-controlled edge / forced-outcome queue). Connects using DATABASE_URL.
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
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_daily_claim BIGINT NOT NULL DEFAULT 0;`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      name       TEXT PRIMARY KEY,
      tokens     BIGINT NOT NULL DEFAULT 0,
      inventory  JSONB  NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // House controls (default edge = 10%):
  await pool.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS edge       DOUBLE PRECISION NOT NULL DEFAULT 0.10;`);
  await pool.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS force_win  INTEGER          NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS force_loss INTEGER          NOT NULL DEFAULT 0;`);

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

// Atomic daily reward: grant tokens AND stamp the claim day in one transaction,
// so a crash can't leave the tokens granted but the claim un-recorded (which
// would allow a double-claim). `day` is a UTC day index, e.g. floor(now/86400).
async function claimDaily(userId, day, amount) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1,0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const { rows } = await client.query("SELECT tokens, last_daily_claim FROM players WHERE user_id=$1 FOR UPDATE", [userId]);
    const last = Number(rows[0].last_daily_claim);
    if (day <= last) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_claimed", tokens: Number(rows[0].tokens), lastDay: last };
    }
    const upd = await client.query(
      "UPDATE players SET tokens = tokens + $2, last_daily_claim = $3, updated_at = now() WHERE user_id = $1 RETURNING tokens",
      [userId, Math.trunc(amount), day]
    );
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
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

/* ---------------- Bots (the house, keyed by name) ---------------- */

async function getBot(name) {
  const { rows } = await pool.query("SELECT tokens, inventory FROM bots WHERE name = $1", [name]);
  return rows.length ? { tokens: Number(rows[0].tokens), inventory: rows[0].inventory } : null;
}

async function addBotTokens(name, delta) {
  const { rows } = await pool.query(
    `INSERT INTO bots (name, tokens) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET tokens = bots.tokens + $2, updated_at = now()
     RETURNING tokens`,
    [name, Math.trunc(delta)]
  );
  return { ok: true, tokens: Number(rows[0].tokens) };
}

async function grantBotItems(name, items) {
  const list = Array.isArray(items) ? items : [];
  const { rows } = await pool.query(
    `INSERT INTO bots (name, inventory) VALUES ($1, $2::jsonb)
     ON CONFLICT (name) DO UPDATE SET inventory = bots.inventory || $2::jsonb, updated_at = now()
     RETURNING inventory`,
    [name, JSON.stringify(list)]
  );
  return { ok: true, inventory: rows[0].inventory };
}

// Atomic spend: deduct only if the bot can afford it. The row lock serializes
// concurrent callers so the house can't be double-spent (e.g. many players
// calling the bot into coinflips at once).
async function spendBotTokens(name, amount) {
  amount = Math.trunc(amount);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const { rows } = await client.query("SELECT tokens FROM bots WHERE name = $1 FOR UPDATE", [name]);
    const current = Number(rows[0].tokens);
    if (current < amount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const upd = await client.query(
      "UPDATE bots SET tokens = tokens - $2, updated_at = now() WHERE name = $1 RETURNING tokens",
      [name, amount]
    );
    await client.query("COMMIT");
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomically commit an item stake the caller already planned: remove the chosen
// held items from the bot's inventory and deduct tokens for the minted items,
// in one transaction. The caller (CoinflipService) decides held vs mint from the
// live market + bot state; this revalidates under a row lock and returns
// { ok:false, reason:"retry" } if a held item is gone (bot changed meanwhile),
// or { ok:false, reason:"insufficient" } if tokens can't cover the mints.
// Returns { ok, items:[...] } with the full staked list (held + minted).
async function commitBotStake(name, heldToConsume, mintItems) {
  const held = Array.isArray(heldToConsume) ? heldToConsume : [];
  const mint = Array.isArray(mintItems) ? mintItems : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const { rows } = await client.query("SELECT tokens, inventory FROM bots WHERE name=$1 FOR UPDATE", [name]);
    let tokens = Number(rows[0].tokens);
    let inv = Array.isArray(rows[0].inventory) ? rows[0].inventory.slice() : [];

    // remove the chosen held items (one per entry, matched by Id)
    const stakedHeld = [];
    for (const h of held) {
      const idx = inv.findIndex((it) => String(it.Id) === String(h.Id));
      if (idx === -1) { await client.query("ROLLBACK"); return { ok: false, reason: "retry" }; }
      stakedHeld.push(inv[idx]);
      inv.splice(idx, 1);
    }

    // pay for the minted items
    const mintCost = mint.reduce((s, it) => s + Math.trunc(Number(it.Value) || 0), 0);
    if (tokens < mintCost) { await client.query("ROLLBACK"); return { ok: false, reason: "insufficient", tokens }; }
    tokens -= mintCost;

    await client.query("UPDATE bots SET tokens=$2, inventory=$3::jsonb, updated_at=now() WHERE name=$1",
      [name, Math.trunc(tokens), JSON.stringify(inv)]);
    await client.query("COMMIT");

    const items = stakedHeld.concat(mint.map((it) => ({ Id: it.Id, Name: it.Name, Value: Math.trunc(Number(it.Value) || 0) })));
    return { ok: true, items };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomically decide + consume one outcome for the next bot game.
// s: 0 = use edge, 1 = forced win, 2 = forced loss.  v = current edge.
// Precedence: forced wins -> forced losses -> edge. FOR UPDATE means concurrent
// games can't both consume the same queued win/loss.
async function consumeBotOutcome(name) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const { rows } = await client.query(
      "SELECT edge, force_win, force_loss FROM bots WHERE name = $1 FOR UPDATE", [name]);
    const r = rows[0];
    let s = 0;
    if (Number(r.force_win) > 0) {
      s = 1;
      await client.query("UPDATE bots SET force_win = force_win - 1, updated_at = now() WHERE name = $1", [name]);
    } else if (Number(r.force_loss) > 0) {
      s = 2;
      await client.query("UPDATE bots SET force_loss = force_loss - 1, updated_at = now() WHERE name = $1", [name]);
    }
    await client.query("COMMIT");
    return { s, v: Number(r.edge) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Control surface for your Discord bot. Pass any of edge / force_win / force_loss;
// omitted fields are left unchanged.
async function setBotControl(name, { edge, force_win, force_loss }) {
  await pool.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
  const { rows } = await pool.query(
    `UPDATE bots SET edge       = COALESCE($2, edge),
                     force_win  = COALESCE($3, force_win),
                     force_loss = COALESCE($4, force_loss),
                     updated_at = now()
     WHERE name = $1
     RETURNING edge, force_win, force_loss`,
    [name, edge ?? null, force_win ?? null, force_loss ?? null]
  );
  return { ok: true, ...rows[0] };
}

module.exports = {
  init, getPlayer, setPlayer, getInventory, addTokens, purchase, grantItems, claimDaily,
  saveBattle, getBattle, recentBattles, playerBattles,
  getBot, addBotTokens, grantBotItems, spendBotTokens, commitBotStake, consumeBotOutcome, setBotControl, pool,
};
