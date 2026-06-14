/**
 * db.js  (count-based inventory)
 * ------------------------------
 * Postgres data layer. Inventories are stored as count-based STACKS
 * ({Id, Name, Value, Count}); copies of the same Id merge into one stack.
 * Changes vs the flat version:
 *   - players.inventory_value maintained column (leaderboard reads it, no unnest)
 *   - players.inventory_value is also kept correct by a DB trigger, so manual
 *     edits to the inventory JSONB can never leave it stale
 *   - grantItems / purchase MERGE by Id (no blind append of duplicate stacks)
 *   - battle list endpoints return a projection (no per-item arrays)
 *   - commitBotStake decrements stack Counts
 * The normalize helpers are inlined here and exported (migrate-stacks.js uses them),
 * and mirror the Roblox ItemStacks module byte-for-byte in behaviour.
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false }, // only if using the PUBLIC proxy URL
});

/* ---------------- Stack helpers (shared contract) ---------------- */

function normCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

// Accepts a flat array (legacy, no Count) OR stacks; returns merged stacks
// (one per Id). Idempotent -- safe to run repeatedly and to mix formats.
function normalizeInventory(raw) {
  if (!Array.isArray(raw)) return [];
  const order = [];
  const byId = new Map();
  for (const entry of raw) {
    if (entry && typeof entry === "object" && entry.Id != null) {
      const id = String(entry.Id);
      let stack = byId.get(id);
      if (!stack) {
        stack = { Id: id, Name: entry.Name, Value: entry.Value, Count: 0 };
        byId.set(id, stack);
        order.push(stack);
      }
      if (entry.Name != null) stack.Name = entry.Name;
      if (entry.Value != null) stack.Value = entry.Value;
      stack.Count += normCount(entry.Count);
    }
  }
  return order.filter((s) => s.Count > 0);
}

// Merge `items` (flat entries or stacks) into an already-normalized `base`.
function mergeStacks(base, items) {
  return normalizeInventory((Array.isArray(base) ? base : []).concat(Array.isArray(items) ? items : []));
}

function inventoryValue(stacks) {
  let v = 0;
  for (const s of Array.isArray(stacks) ? stacks : []) {
    v += (Number(s.Value) || 0) * (Number(s.Count) || 1);
  }
  return Math.trunc(v);
}

function itemCount(stacks) {
  let n = 0;
  for (const s of Array.isArray(stacks) ? stacks : []) {
    n += (Number(s.Count) || 1);
  }
  return n;
}

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
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS inventory_value BIGINT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_daily_claim BIGINT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS wagered BIGINT NOT NULL DEFAULT 0;`);
  // Per-player game stats:
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS tokens_bet    BIGINT  NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS value_bet     BIGINT  NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS tokens_profit BIGINT  NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS value_profit  BIGINT  NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS games_played  INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS games_won     INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS games_lost    INTEGER NOT NULL DEFAULT 0;`);
  // Rank: biggest single-coinflip wager + the resulting rank string.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS top_wager BIGINT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS rank TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_players_inventory_value ON players(inventory_value DESC);`);

  // Keep players.inventory_value correct on EVERY write to inventory -- including
  // manual DB edits -- via a trigger (per-row jsonb sum, negligible cost).
  // The leaderboard still just reads the column.
  await pool.query(`
    CREATE OR REPLACE FUNCTION players_set_inventory_value()
    RETURNS trigger AS $func$
    BEGIN
      NEW.inventory_value := (
        CASE WHEN jsonb_typeof(NEW.inventory) = 'array' THEN COALESCE((
          SELECT SUM(COALESCE((elem->>'Value')::numeric, 0) * COALESCE((elem->>'Count')::numeric, 1))
          FROM jsonb_array_elements(NEW.inventory) elem
        ), 0) ELSE 0 END
      )::bigint;
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trg_players_inventory_value ON players;`);
  await pool.query(`
    CREATE TRIGGER trg_players_inventory_value
    BEFORE INSERT OR UPDATE OF inventory ON players
    FOR EACH ROW EXECUTE FUNCTION players_set_inventory_value();
  `);
  // One-time self-heal for rows written before the trigger existed (no-op once correct).
  await pool.query(`
    WITH calc AS (
      SELECT user_id,
             CASE WHEN jsonb_typeof(inventory) = 'array' THEN COALESCE((
               SELECT SUM(COALESCE((e->>'Value')::numeric, 0) * COALESCE((e->>'Count')::numeric, 1))
               FROM jsonb_array_elements(inventory) e
             ), 0) ELSE 0 END AS v
      FROM players
    )
    UPDATE players p SET inventory_value = calc.v
    FROM calc
    WHERE p.user_id = calc.user_id AND p.inventory_value IS DISTINCT FROM calc.v;
  `);

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

  // Leaderboard snapshot, rebuilt from `players` on write (debounced) + on an interval.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      board      TEXT    NOT NULL,
      rank       INTEGER NOT NULL,
      user_id    BIGINT  NOT NULL,
      value      BIGINT  NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (board, rank)
    );
  `);

  // Redeem codes + per-player redemption ledger.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS codes (
      code        TEXT PRIMARY KEY,
      tokens      BIGINT  NOT NULL DEFAULT 0,
      max_uses    INTEGER,                 -- NULL = unlimited
      uses        INTEGER NOT NULL DEFAULT 0,
      expires_at  TIMESTAMPTZ,             -- NULL = never expires
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS code_redemptions (
      code        TEXT   NOT NULL,
      user_id     BIGINT NOT NULL,
      tokens      BIGINT NOT NULL,
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (code, user_id)
    );
  `);

  console.log("[db] tables ready");
}

/* ---------------- Players ---------------- */

async function getPlayer(userId) {
  const { rows } = await pool.query("SELECT tokens, inventory, wagered FROM players WHERE user_id = $1", [userId]);
  return rows.length
    ? { tokens: Number(rows[0].tokens), inventory: normalizeInventory(rows[0].inventory), wagered: Number(rows[0].wagered) }
    : null;
}

// Partial update: only the fields you pass are changed. When inventory is
// provided it is normalized to stacks and inventory_value is recomputed in the
// same write. wagered is monotonic (GREATEST guards against lowering it).
async function setPlayer(userId, tokens, inventory, wagered) {
  const tokParam = tokens === undefined || tokens === null ? null : Math.trunc(tokens);
  const stacks = inventory === undefined || inventory === null ? null : normalizeInventory(inventory);
  const invParam = stacks === null ? null : JSON.stringify(stacks);
  const valParam = stacks === null ? null : inventoryValue(stacks);
  const wagParam = wagered === undefined || wagered === null ? null : Math.trunc(wagered);
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, tokens, inventory, inventory_value, wagered)
       VALUES ($1, COALESCE($2::bigint, 0), COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::bigint, 0), COALESCE($5::bigint, 0))
     ON CONFLICT (user_id) DO UPDATE
       SET tokens          = COALESCE($2::bigint, players.tokens),
           inventory       = COALESCE($3::jsonb, players.inventory),
           inventory_value = COALESCE($4::bigint, players.inventory_value),
           wagered         = GREATEST(players.wagered, COALESCE($5::bigint, players.wagered)),
           updated_at = now()
     RETURNING tokens, inventory, wagered`,
    [userId, tokParam, invParam, valParam, wagParam]
  );
  markLeaderboardDirty();
  return { tokens: Number(rows[0].tokens), inventory: normalizeInventory(rows[0].inventory), wagered: Number(rows[0].wagered) };
}

async function getInventory(userId) {
  const { rows } = await pool.query("SELECT inventory FROM players WHERE user_id = $1", [userId]);
  return rows.length ? normalizeInventory(rows[0].inventory) : [];
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
    markLeaderboardDirty();
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomic purchase: deduct price AND merge the item stack in one transaction.
async function purchase(userId, price, item) {
  price = Math.trunc(price);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const { rows } = await client.query("SELECT tokens, inventory FROM players WHERE user_id = $1 FOR UPDATE", [userId]);
    const current = Number(rows[0].tokens);
    if (current < price) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient", tokens: current };
    }
    const merged = mergeStacks(normalizeInventory(rows[0].inventory), [item]);
    const value = inventoryValue(merged);
    const upd = await client.query(
      `UPDATE players SET tokens = tokens - $2, inventory = $3::jsonb, inventory_value = $4, updated_at = now()
       WHERE user_id = $1 RETURNING tokens, inventory`,
      [userId, price, JSON.stringify(merged), value]
    );
    await client.query("COMMIT");
    markLeaderboardDirty();
    return { ok: true, tokens: Number(upd.rows[0].tokens), inventory: normalizeInventory(upd.rows[0].inventory) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomically merge item stack(s) into a player's inventory (online or offline).
async function grantItems(userId, items) {
  const incoming = normalizeInventory(Array.isArray(items) ? items : []);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const { rows } = await client.query("SELECT inventory FROM players WHERE user_id = $1 FOR UPDATE", [userId]);
    const merged = mergeStacks(normalizeInventory(rows[0].inventory), incoming);
    const value = inventoryValue(merged);
    const upd = await client.query(
      "UPDATE players SET inventory = $2::jsonb, inventory_value = $3, updated_at = now() WHERE user_id = $1 RETURNING inventory",
      [userId, JSON.stringify(merged), value]
    );
    await client.query("COMMIT");
    markLeaderboardDirty();
    return { ok: true, inventory: normalizeInventory(upd.rows[0].inventory) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomic daily reward: grant tokens AND stamp the claim day in one transaction.
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
    markLeaderboardDirty();
    return { ok: true, tokens: Number(upd.rows[0].tokens) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

// Atomic increment of all-time wagered.
async function addWagered(userId, amount) {
  const delta = Math.trunc(amount);
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, wagered) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET wagered = players.wagered + $2, updated_at = now()
     RETURNING wagered`,
    [userId, delta]
  );
  markLeaderboardDirty();
  return { ok: true, wagered: Number(rows[0].wagered) };
}

/* ---------------- Player stats ---------------- */

function mapStats(r) {
  return {
    tokensBet: Number(r.tokens_bet || 0),
    valueBet: Number(r.value_bet || 0),
    tokensProfit: Number(r.tokens_profit || 0),
    valueProfit: Number(r.value_profit || 0),
    gamesPlayed: Number(r.games_played || 0),
    gamesWon: Number(r.games_won || 0),
    gamesLost: Number(r.games_lost || 0),
    topWager: Number(r.top_wager || 0),
    rank: r.rank ?? null,
  };
}

async function recordGame(userId, { bet, betType, opponentValue, won }) {
  bet = Math.max(0, Math.trunc(Number(bet) || 0));
  const opp = Math.max(0, Math.trunc(Number(opponentValue) || 0));
  const profit = won ? opp : -bet;
  const isTokens = betType === "tokens";
  const tb = isTokens ? bet : 0,    vb = isTokens ? 0 : bet;
  const tp = isTokens ? profit : 0, vp = isTokens ? 0 : profit;
  const w = won ? 1 : 0,            l = won ? 0 : 1;

  const { rows } = await pool.query(
    `INSERT INTO players (user_id, wagered, tokens_bet, value_bet, tokens_profit, value_profit, games_played, games_won, games_lost, top_wager)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       wagered       = players.wagered       + $2,
       tokens_bet    = players.tokens_bet    + $3,
       value_bet     = players.value_bet     + $4,
       tokens_profit = players.tokens_profit + $5,
       value_profit  = players.value_profit  + $6,
       games_played  = players.games_played  + 1,
       games_won     = players.games_won     + $7,
       games_lost    = players.games_lost    + $8,
       top_wager     = GREATEST(players.top_wager, $2),
       updated_at = now()
     RETURNING tokens_bet, value_bet, tokens_profit, value_profit, games_played, games_won, games_lost, top_wager`,
    [userId, bet, tb, vb, tp, vp, w, l]
  );
  markLeaderboardDirty();
  return { ok: true, stats: mapStats(rows[0]) };
}

async function getStats(userId) {
  const { rows } = await pool.query(
    `SELECT tokens_bet, value_bet, tokens_profit, value_profit, games_played, games_won, games_lost, top_wager, rank
       FROM players WHERE user_id = $1`, [userId]);
  return mapStats(rows.length ? rows[0] : {});
}

async function setRank(userId, rank) {
  const { rows } = await pool.query(
    `INSERT INTO players (user_id, rank) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET rank = $2, updated_at = now()
     RETURNING rank`,
    [userId, rank || null]
  );
  return { ok: true, rank: rows[0].rank };
}

/* ---------------- Leaderboards ---------------- */

// value board now reads the maintained inventory_value column -- no jsonb unnest.
async function computeBoards(n) {
  const tokensQ = pool.query(
    "SELECT user_id, tokens AS value FROM players ORDER BY tokens DESC LIMIT $1", [n]);

  const wageredQ = pool.query(
    "SELECT user_id, wagered AS value FROM players ORDER BY wagered DESC LIMIT $1", [n]);

  const valueQ = pool.query(
    "SELECT user_id, inventory_value AS value FROM players ORDER BY inventory_value DESC LIMIT $1", [n]);

  const [tokens, wagered, value] = await Promise.all([tokensQ, wageredQ, valueQ]);
  const map = (r) => r.rows.map((row) => ({ userId: Number(row.user_id), value: Number(row.value) }));
  return { value: map(value), wagered: map(wagered), tokens: map(tokens) };
}

const STORE_TOP = 100;
async function refreshLeaderboard() {
  const boards = await computeBoards(STORE_TOP);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM leaderboard");
    for (const board of Object.keys(boards)) {
      const list = boards[board];
      for (let i = 0; i < list.length; i++) {
        await client.query(
          "INSERT INTO leaderboard (board, rank, user_id, value, updated_at) VALUES ($1,$2,$3,$4, now())",
          [board, i + 1, list[i].userId, list[i].value]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  return boards;
}

let _lbDirtyTimer = null;
function markLeaderboardDirty(delayMs = 2000) {
  if (_lbDirtyTimer) return;
  _lbDirtyTimer = setTimeout(() => {
    _lbDirtyTimer = null;
    refreshLeaderboard().catch((e) => console.error("[leaderboard] dirty refresh failed:", e.message));
  }, delayMs);
  if (typeof _lbDirtyTimer.unref === "function") _lbDirtyTimer.unref();
}

async function leaderboard(limit) {
  const n = Math.min(Math.max(parseInt(limit) || 10, 1), 100);
  const { rows } = await pool.query(
    "SELECT board, user_id, value FROM leaderboard WHERE rank <= $1 ORDER BY board, rank", [n]);
  const out = { value: [], wagered: [], tokens: [] };
  for (const r of rows) {
    if (out[r.board]) out[r.board].push({ userId: Number(r.user_id), value: Number(r.value) });
  }
  return out;
}

/* ---------------- Codes ---------------- */

async function redeemCode(code, userId) {
  code = String(code).toUpperCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT tokens, max_uses, uses, expires_at, active FROM codes WHERE code = $1 FOR UPDATE", [code]);
    if (!rows.length) { await client.query("ROLLBACK"); return { ok: false, reason: "invalid_code" }; }

    const c = rows[0];
    if (!c.active) { await client.query("ROLLBACK"); return { ok: false, reason: "inactive" }; }
    if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK"); return { ok: false, reason: "expired" };
    }
    if (c.max_uses != null && Number(c.uses) >= Number(c.max_uses)) {
      await client.query("ROLLBACK"); return { ok: false, reason: "maxed" };
    }

    const reward = Number(c.tokens);
    const ins = await client.query(
      "INSERT INTO code_redemptions (code, user_id, tokens) VALUES ($1,$2,$3) ON CONFLICT (code, user_id) DO NOTHING",
      [code, userId, reward]
    );
    if (ins.rowCount === 0) { await client.query("ROLLBACK"); return { ok: false, reason: "already_redeemed" }; }

    await client.query("UPDATE codes SET uses = uses + 1, updated_at = now() WHERE code = $1", [code]);
    await client.query("INSERT INTO players (user_id, tokens) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING", [userId]);
    const upd = await client.query(
      "UPDATE players SET tokens = tokens + $2, updated_at = now() WHERE user_id = $1 RETURNING tokens",
      [userId, reward]
    );
    await client.query("COMMIT");
    markLeaderboardDirty();
    return { ok: true, tokens: Number(upd.rows[0].tokens), reward };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

async function getActiveCodes() {
  const { rows } = await pool.query(
    `SELECT code, tokens, max_uses, uses, expires_at
       FROM codes
      WHERE active = true
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR uses < max_uses)
      ORDER BY created_at DESC`);
  return rows.map((r) => ({
    code: r.code, tokens: Number(r.tokens),
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    uses: Number(r.uses), expiresAt: r.expires_at,
  }));
}

async function getCode(code) {
  const { rows } = await pool.query("SELECT * FROM codes WHERE code = $1", [String(code).toUpperCase()]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    code: r.code, tokens: Number(r.tokens),
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    uses: Number(r.uses), expiresAt: r.expires_at, active: r.active,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

async function upsertCode(code, { tokens, maxUses, expiresAt, active }) {
  code = String(code).toUpperCase();
  const { rows } = await pool.query(
    `INSERT INTO codes (code, tokens, max_uses, expires_at, active)
       VALUES ($1, COALESCE($2,0), $3, $4, COALESCE($5, true))
     ON CONFLICT (code) DO UPDATE SET
       tokens     = COALESCE($2, codes.tokens),
       max_uses   = $3,
       expires_at = $4,
       active     = COALESCE($5, codes.active),
       updated_at = now()
     RETURNING code`,
    [code, tokens == null ? null : Math.trunc(tokens),
     maxUses == null ? null : Math.trunc(maxUses), expiresAt ?? null,
     typeof active === "boolean" ? active : null]
  );
  return { ok: true, code: rows[0].code };
}

async function setCodeActive(code, active) {
  const { rows } = await pool.query(
    "UPDATE codes SET active = $2, updated_at = now() WHERE code = $1 RETURNING code, active",
    [String(code).toUpperCase(), !!active]
  );
  if (!rows.length) return { ok: false, reason: "invalid_code" };
  return { ok: true, code: rows[0].code, active: rows[0].active };
}

/* ---------------- Battles ---------------- */

// Trimmed list view: no per-item arrays, just an itemCount per player.
function projectBattle(data) {
  if (!data || typeof data !== "object") return data;
  const players = Array.isArray(data.players)
    ? data.players.map((p) => ({
        userId: p.userId, name: p.name, role: p.role, coin: p.coin,
        value: p.value, tokens: p.tokens, itemCount: itemCount(p.items),
      }))
    : [];
  return {
    id: data.id, battleNumber: data.battleNumber, status: data.status,
    initiator: data.initiator, winner: data.winner, totalValue: data.totalValue,
    players,
  };
}

async function saveBattle(record) {
  if (Array.isArray(record.players)) {
    for (const p of record.players) {
      if (Array.isArray(p.items)) p.items = normalizeInventory(p.items);
    }
  }
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
  return rows.map((r) => projectBattle(r.data));
}

async function playerBattles(userId, limit) {
  const { rows } = await pool.query(
    "SELECT data FROM battles WHERE $1 = ANY(participants) ORDER BY created_at DESC LIMIT $2",
    [userId, clampLimit(limit)]
  );
  return rows.map((r) => projectBattle(r.data));
}

/* ---------------- Bots (the house, keyed by name) ---------------- */

async function getBot(name) {
  const { rows } = await pool.query("SELECT tokens, inventory FROM bots WHERE name = $1", [name]);
  return rows.length ? { tokens: Number(rows[0].tokens), inventory: normalizeInventory(rows[0].inventory) } : null;
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

// Merge item stack(s) into the bot's inventory under a row lock.
async function grantBotItems(name, items) {
  const incoming = normalizeInventory(Array.isArray(items) ? items : []);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const { rows } = await client.query("SELECT inventory FROM bots WHERE name = $1 FOR UPDATE", [name]);
    const merged = mergeStacks(normalizeInventory(rows[0].inventory), incoming);
    const upd = await client.query(
      "UPDATE bots SET inventory = $2::jsonb, updated_at = now() WHERE name = $1 RETURNING inventory",
      [name, JSON.stringify(merged)]
    );
    await client.query("COMMIT");
    return { ok: true, inventory: normalizeInventory(upd.rows[0].inventory) };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

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

// Atomically commit a staked set. `held` are stacks (with Count) to remove from
// the bot's inventory; `mint` are stacks to buy with tokens. Returns the full
// staked stack list, or { ok:false, reason } on retry/insufficient.
async function commitBotStake(name, heldToConsume, mintItems) {
  const held = normalizeInventory(Array.isArray(heldToConsume) ? heldToConsume : []);
  const mint = normalizeInventory(Array.isArray(mintItems) ? mintItems : []);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO bots (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    const { rows } = await client.query("SELECT tokens, inventory FROM bots WHERE name=$1 FOR UPDATE", [name]);
    let tokens = Number(rows[0].tokens);
    let inv = normalizeInventory(rows[0].inventory);

    // remove the chosen held stacks (decrement Count, matched by Id)
    const stakedHeld = [];
    for (const h of held) {
      const id = String(h.Id);
      const need = Number(h.Count) || 1;
      const idx = inv.findIndex((it) => String(it.Id) === id);
      if (idx === -1 || (Number(inv[idx].Count) || 1) < need) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "retry" };
      }
      const st = inv[idx];
      stakedHeld.push({ Id: st.Id, Name: st.Name, Value: st.Value, Count: need });
      const left = (Number(st.Count) || 1) - need;
      if (left <= 0) inv.splice(idx, 1);
      else st.Count = left;
    }

    // pay for the minted stacks
    const mintCost = mint.reduce((s, it) => s + (Math.trunc(Number(it.Value)) || 0) * (Number(it.Count) || 1), 0);
    if (tokens < mintCost) { await client.query("ROLLBACK"); return { ok: false, reason: "insufficient", tokens }; }
    tokens -= mintCost;

    await client.query("UPDATE bots SET tokens=$2, inventory=$3::jsonb, updated_at=now() WHERE name=$1",
      [name, Math.trunc(tokens), JSON.stringify(inv)]);
    await client.query("COMMIT");

    const items = mergeStacks(stakedHeld, mint);
    return { ok: true, items };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

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
  init, getPlayer, setPlayer, getInventory, addTokens, purchase, grantItems, claimDaily, addWagered,
  recordGame, getStats, setRank,
  computeBoards, refreshLeaderboard, leaderboard,
  redeemCode, getActiveCodes, getCode, upsertCode, setCodeActive,
  saveBattle, getBattle, recentBattles, playerBattles,
  getBot, addBotTokens, grantBotItems, spendBotTokens, commitBotStake, consumeBotOutcome, setBotControl,
  normalizeInventory, mergeStacks, inventoryValue, itemCount, pool,
};
