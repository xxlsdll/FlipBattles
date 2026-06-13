/**
 * api.js  (Node.js)
 * -----------------
 * Scrapes Rolimon's classic limiteds on a schedule and serves them as JSON,
 * AND exposes player (tokens/inventory) + battle + bot routes backed by Postgres,
 * plus a composite "P1 vs P2" headshot banner for the whale-battle Discord embed.
 *
 * Requires Node.js 18+.  Run: npm install && node api.js
 *   (banner dependency: @napi-rs/canvas)
 *
 * Routes:
 *   GET  /                         -> health/status                            (public)
 *   GET  /limiteds                 -> { version, updated_at, count, items }     (public)
 *   GET  /version                  -> { version, count, updated_at }            (public)
 *   GET  /limiteds.js              -> const Limiteds = {...}  (JS consumers)     (public)
 *   GET  /limiteds/:id             -> single item                               (public)
 *   GET  /vs                       -> PNG  (P1 vs P2 banner; ?u1=&c1=&u2=&c2=)   (public)
 *   GET  /players/:id              -> { user_id, tokens, inventory, wagered }   (key)
 *   PUT  /players/:id              -> { user_id, tokens, inventory, wagered }   (key)
 *   GET  /players/:id/inventory    -> { user_id, count, inventory }            (key)
 *   POST /players/:id/add          -> { ok, tokens } | { ok:false, reason, tokens }   (key)
 *   POST /players/:id/give         -> { ok, tokens }  (grant + instant push)    (key)
 *   POST /players/:id/set          -> { ok, tokens }  (absolute set + instant push)  (key)
 *   POST /players/:id/purchase     -> { ok, tokens, inventory } | { ok:false, ... }   (key)
 *   POST /players/:id/grant        -> { ok, inventory }  (atomic append; offline-safe) (key)
 *   POST /players/:id/daily        -> { ok, tokens } | { ok:false, already_claimed }   (key)
 *   POST /players/:id/wager        -> { ok, wagered }  (atomic increment)       (key)
 *   POST /players/:id/game         -> { ok, stats }  (record a resolved game)   (key)
 *   POST /players/:id/rank         -> { ok, rank }  (persist rank string)       (key)
 *   GET  /players/:id/stats        -> { user_id, stats }                        (key)
 *   GET  /players/:id/battles      -> { user_id, battles }                     (key)
 *   GET  /battles                  -> { battles }  (recent; ?limit=)           (key)
 *   PUT  /battles/:id              -> { ok }  (log/upsert a battle)            (key)
 *   GET  /battles/:id              -> full battle record                       (key)
 *   GET  /leaderboard              -> { value, wagered, tokens }  (top-N each)  (key)
 *   GET  /codes                    -> { codes }  (active codes)                (key)
 *   GET  /codes/:code              -> full code record                         (key)
 *   PUT  /codes/:code              -> { ok, code }  (create/update; bot)        (key)
 *   POST /codes/:code/redeem       -> { ok, tokens, reward } | { ok:false, reason }  (key)
 *   POST /codes/:code/deactivate   -> { ok, code, active }                      (key)
 *   GET  /bots/:name               -> { name, tokens, inventory }              (key)
 *   GET  /bots/:name/inventory     -> { name, count, inventory }              (key)
 *   POST /bots/:name/add           -> { ok, tokens }  (atomic)                 (key)
 *   POST /bots/:name/grant         -> { ok, inventory }  (atomic append)       (key)
 *   POST /bots/:name/spend         -> { ok, tokens } | { ok:false, insufficient } (key)
 *   POST /bots/:name/stake         -> { ok, items } | { ok:false, retry|insufficient }  (key)
 *   POST /bots/:name/sync          -> { ok, s, v }  (consume next bot outcome) (key)
 *   POST /bots/:name/control       -> { ok, edge, force_win, force_loss }      (key)
 */

const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./db");

// Optional -- the /vs banner needs @napi-rs/canvas, but a missing module must
// NOT crash the whole API. Install it with: npm install @napi-rs/canvas
let createCanvas = null, loadImage = null, GlobalFonts = null;
try {
  ({ createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas"));
} catch (e) {
  console.warn("[vs] @napi-rs/canvas not installed -- /vs banner disabled until you run `npm install @napi-rs/canvas`");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

const MIN_VALUE = 10_000;
const MAX_VALUE = 40_000_000;

const REFRESH_MS = 10 * 60 * 1000;          // re-scrape every 10 minutes
const LEADERBOARD_REFRESH_MS = 60 * 1000;   // rebuild the leaderboard snapshot every 60s
const CACHE_FILE = "limiteds_cache.json";
const PORT = process.env.PORT || 8080;

// Set this in Railway -> Variables, equal to your Roblox GameApiKey.
const API_KEY = process.env.API_KEY || "";

// Roblox Open Cloud -- for instant token pushes to live servers via MessagingService.
const OPEN_CLOUD_KEY = process.env.OPEN_CLOUD_KEY || "";  // key w/ messaging-service publish scope
const UNIVERSE_ID = process.env.UNIVERSE_ID || "";        // experience's Universe ID (not place ID)
const SYNC_TOPIC = "TokenSync";                           // must match TokensConfig.SyncTopic

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://www.rolimons.com/",
};

const NAME = 0, RAP = 2, VALUE = 3;

// ---------------------------------------------------------------------------
// Limiteds state + scraper
// ---------------------------------------------------------------------------
let state = { items: {}, version: 0, hash: null, updatedAt: null, count: 0 };

async function scrape() {
  const resp = await fetch(ITEM_DETAILS_URL, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const payload = await resp.json();
  if (!payload.success) throw new Error("Rolimon's returned success=false");

  const items = [];
  for (const [itemId, fields] of Object.entries(payload.items)) {
    const value = fields[VALUE];
    const rap = fields[RAP];
    const effective = value === -1 ? rap : value;   // -1 => no value set, use RAP
    if (effective < MIN_VALUE || effective > MAX_VALUE) continue;
    items.push([
      Number(itemId),
      { name: fields[NAME], headshot: `rbxthumb://type=Asset&id=${itemId}&w=150&h=150`, value: effective },
    ]);
  }

  items.sort((a, b) => b[1].value - a[1].value);   // most valuable first
  const table = {};
  for (const [id, data] of items) table[String(id)] = data;
  return table;
}

function hashTable(items) {
  const sorted = {};
  for (const k of Object.keys(items).sort()) sorted[k] = items[k];
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function applyUpdate(newItems) {
  const newHash = hashTable(newItems);
  if (newHash === state.hash) return false;

  const old = state.items;
  const added = Object.keys(newItems).filter((k) => !(k in old));
  const removed = Object.keys(old).filter((k) => !(k in newItems));
  const changed = Object.keys(newItems).filter((k) => k in old && old[k].value !== newItems[k].value);

  state.items = newItems;
  state.hash = newHash;
  state.version += 1;
  state.count = Object.keys(newItems).length;
  state.updatedAt = new Date().toISOString();

  saveCache();
  console.log(`[update] v${state.version}  total=${state.count}  +${added.length} added  -${removed.length} removed  ~${changed.length} value changes`);
  return true;
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: state.version, items: state.items }));
  } catch (e) { console.error("[cache write error]", e.message); }
}

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    state.items = data.items || {};
    state.hash = hashTable(state.items);
    state.version = data.version || 0;
    state.count = Object.keys(state.items).length;
    state.updatedAt = new Date().toISOString();
    console.log(`[cache] loaded ${state.count} limiteds from ${CACHE_FILE}`);
  } catch { /* no cache yet -- fine */ }
}

async function refreshOnce() {
  try {
    const table = await scrape();
    if (!applyUpdate(table)) console.log("[refresh] no change");
  } catch (e) { console.error(`[scrape error] ${e.message} -- keeping last good data`); }
}

// ---------------------------------------------------------------------------
// Auth + helpers
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 500 if the key isn't configured (obvious misconfig in logs), 401 if it
// doesn't match. Both are non-2xx, so TokensService treats either as
// "DB unreachable" and stays on ProfileStore.
function requireKey(req, res, next) {
  if (!API_KEY) {
    console.error("[auth] API_KEY env var is not set -- rejecting protected request");
    return res.status(500).json({ error: "server_misconfigured" });
  }
  const provided = req.get("x-api-key");
  if (!provided || !safeEqual(provided, API_KEY)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Push a player's new balance to live game servers via Open Cloud MessagingService.
// Best-effort: logs and returns false if creds are missing or the call fails.
async function publishTokens(userId, tokens) {
  if (!OPEN_CLOUD_KEY || !UNIVERSE_ID) {
    console.warn("[push] OPEN_CLOUD_KEY / UNIVERSE_ID not set -- instant push skipped");
    return false;
  }
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${SYNC_TOPIC}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": OPEN_CLOUD_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ message: JSON.stringify({ userId: Number(userId), tokens: Number(tokens) }) }),
    });
    if (!resp.ok) { console.error("[push] messaging HTTP", resp.status); return false; }
    return true;
  } catch (e) { console.error("[push] error:", e.message); return false; }
}

// --- VS banner (composite headshot image for the whale-battle embed) ---------
// Ring color per coin side -- match these to your in-game coin emojis. Tweak freely.
const COIN_COLORS = { bux: "#3ba55d", tix: "#e8862e" };
const RING_DEFAULT = "#dfe2e6";
function ringColor(coin) {
  return COIN_COLORS[String(coin || "").toLowerCase()] || RING_DEFAULT;
}

// Railway's container has no system font, so canvas text won't render. Load one
// at runtime (lazy + cached, non-fatal) so the "VS" actually draws.
const FONT_URL = "https://cdn.jsdelivr.net/npm/@expo-google-fonts/inter/Inter_900Black.ttf";
let FONT = "sans-serif";
async function ensureFont() {
  if (FONT !== "sans-serif" || !GlobalFonts) return;
  try {
    const resp = await fetch(FONT_URL);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    GlobalFonts.register(Buffer.from(await resp.arrayBuffer()), "VsFont");
    FONT = "VsFont";
    console.log("[vs] font registered");
  } catch (e) { console.warn("[vs] font register failed -- VS text may not show:", e.message); }
}

// Fetch a user's headshot image (thumbnails API returns JSON w/ the real URL).
async function fetchHeadshotImage(userId) {
  try {
    const metaUrl = `https://thumbnails.roproxy.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`;
    const metaResp = await fetch(metaUrl);
    if (!metaResp.ok) return null;
    const meta = await metaResp.json();
    const imageUrl = meta && meta.data && meta.data[0] && meta.data[0].imageUrl;
    if (!imageUrl) return null;
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) return null;
    return await loadImage(Buffer.from(await imgResp.arrayBuffer()));
  } catch (e) { console.error("[vs] headshot fetch:", e.message); return null; }
}

// Compose [P1] VS [P2] with coin-colored rings + glow. u2/c2 may be null (waiting).
async function buildVsImage(u1, c1, u2, c2) {
  const W = 820, H = 360, R = 132, cy = 180;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const [img1, img2] = await Promise.all([
    u1 ? fetchHeadshotImage(u1) : null,
    u2 ? fetchHeadshotImage(u2) : null,
  ]);

  function drawPlayer(img, cx, coin) {
    const color = ringColor(coin);

    // soft outer glow
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 35;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 14;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    // headshot, clipped inside the ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 8, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img) {
      ctx.drawImage(img, cx - R, cy - R, R * 2, R * 2);
    } else {
      ctx.fillStyle = "#2b2d31";
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    ctx.restore();

    // crisp ring on top
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 12;
    ctx.strokeStyle = color;
    ctx.stroke();

    if (!img) {
      ctx.fillStyle = "#9aa0a6";
      ctx.font = `900 120px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", cx, cy);
    }
  }

  drawPlayer(img1, 215, c1);
  drawPlayer(img2, W - 215, c2);

  // VS in the middle
  ctx.font = `900 104px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 14;
  ctx.strokeStyle = "#0d0d0f";
  ctx.strokeText("VS", W / 2, cy);
  ctx.fillStyle = "#ff4757";
  ctx.fillText("VS", W / 2, cy);

  return await canvas.encode("png");
}

const _vsCache = new Map(); // "u1:c1:u2:c2" -> { buf, at }
const VS_TTL_MS = 10 * 60 * 1000;

// Async wrapper: a thrown error becomes next(err) -> error handler -> 500.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// --- Limiteds (public) ---
app.get("/", (req, res) => {
  res.json({ service: "flipbattles-api", version: state.version, count: state.count, updated_at: state.updatedAt });
});

app.get("/version", (req, res) => {
  res.json({ version: state.version, count: state.count, updated_at: state.updatedAt });
});

app.get("/limiteds", (req, res) => {
  res.json({ version: state.version, updated_at: state.updatedAt, count: state.count, items: state.items });
});

app.get("/limiteds.js", (req, res) => {
  const body = JSON.stringify(state.items, null, 2);
  const js =
    `// Auto-generated live  --  v${state.version}, updated ${state.updatedAt}\n` +
    `const Limiteds = ${body};\n\n` +
    `if (typeof module !== "undefined" && module.exports) {\n  module.exports = Limiteds;\n}\n`;
  res.type("application/javascript").send(js);
});

app.get("/limiteds/:id", (req, res) => {
  const item = state.items[req.params.id];
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json(item);
});

// Public PNG banner for the whale embed. Discord fetches this directly (no key).
// ?u1=&c1=&u2=&c2=   (u2/c2 optional -> "waiting" placeholder).
app.get("/vs", wrap(async (req, res) => {
  if (!createCanvas) return res.status(503).json({ error: "vs_unavailable" });
  const u1 = Number(req.query.u1) > 0 ? Math.trunc(Number(req.query.u1)) : null;
  const u2 = Number(req.query.u2) > 0 ? Math.trunc(Number(req.query.u2)) : null;
  const c1 = String(req.query.c1 || "");
  const c2 = String(req.query.c2 || "");
  if (!u1 && !u2) return res.status(400).json({ error: "missing_users" });

  const key = `${u1 || 0}:${c1}:${u2 || 0}:${c2}`;
  const hit = _vsCache.get(key);
  let buf;
  if (hit && Date.now() - hit.at < VS_TTL_MS) {
    buf = hit.buf;
  } else {
    await ensureFont();
    buf = await buildVsImage(u1, c1, u2, c2);
    _vsCache.set(key, { buf, at: Date.now() });
  }
  res.set("Cache-Control", "public, max-age=600");
  res.type("png").send(buf);
}));

// --- Players (tokens + inventory) -- key required ---

// No row -> 200 with tokens:null so a new player falls through to the
// ProfileStore first-join grant.
app.get("/players/:id", requireKey, wrap(async (req, res) => {
  const p = await db.getPlayer(req.params.id);
  res.json({
    user_id: req.params.id,
    tokens: p ? p.tokens : null,
    inventory: p ? p.inventory : null,
    wagered: p ? p.wagered : null,
  });
}));

// Absolute save. inventory is optional: include it to persist, omit to leave
// the stored inventory untouched (so a token-only save can't wipe it).
// wagered is optional too and is clamped monotonically (never decreases).
app.put("/players/:id", requireKey, wrap(async (req, res) => {
  const { tokens, inventory, wagered } = req.body;
  if (tokens !== undefined && tokens !== null && !Number.isFinite(Number(tokens))) {
    return res.status(400).json({ error: "invalid_tokens" });
  }
  if (wagered !== undefined && wagered !== null && !Number.isFinite(Number(wagered))) {
    return res.status(400).json({ error: "invalid_wagered" });
  }
  const p = await db.setPlayer(req.params.id, tokens, inventory, wagered);
  res.json({ user_id: req.params.id, tokens: p.tokens, inventory: p.inventory, wagered: p.wagered });
}));

app.get("/players/:id/inventory", requireKey, wrap(async (req, res) => {
  const inventory = await db.getInventory(req.params.id);
  res.json({ user_id: req.params.id, count: inventory.length, inventory });
}));

// Atomic add/spend (TrySpend). 200 even on ok:false so the Lua reads the body.
app.post("/players/:id/add", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "invalid_amount" });
  res.json(await db.addTokens(req.params.id, Math.trunc(amount), req.body.allowNegative !== false));
}));

// Grant (or remove, if negative) tokens and instantly push the new balance to
// live servers via Open Cloud MessagingService. Body: { amount }.
// This is the endpoint your Discord bot / admin tools should call to ADD tokens.
app.post("/players/:id/give", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "invalid_amount" });
  const result = await db.addTokens(req.params.id, Math.trunc(amount), req.body.allowNegative !== false);
  if (result.ok) await publishTokens(req.params.id, result.tokens);
  res.json(result);
}));

// Set a player's tokens to an absolute value and instantly push it. Body: { tokens }.
// Use this (not a hand-edit of the column) when an admin/Discord tool SETS a balance.
app.post("/players/:id/set", requireKey, wrap(async (req, res) => {
  const tokens = Number(req.body.tokens);
  if (!Number.isFinite(tokens)) return res.status(400).json({ error: "invalid_tokens" });
  const p = await db.setPlayer(req.params.id, Math.trunc(tokens));  // inventory/wagered untouched
  await publishTokens(req.params.id, p.tokens);
  res.json({ ok: true, tokens: p.tokens });
}));

// Atomic purchase: deduct price AND append item in one transaction.
// Body: { price, item }   item = { Id, Name, Value }
app.post("/players/:id/purchase", requireKey, wrap(async (req, res) => {
  const price = Number(req.body.price);
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "invalid_price" });
  if (req.body.item == null || typeof req.body.item !== "object") {
    return res.status(400).json({ error: "invalid_item" });
  }
  res.json(await db.purchase(req.params.id, Math.trunc(price), req.body.item));
}));

// Atomic append of item(s) to inventory. Works for offline players (no loaded
// profile needed) -- used for offline battle winners and offline refunds.
// Body: { items: [ { Id, Name, Value, ... }, ... ] }
app.post("/players/:id/grant", requireKey, wrap(async (req, res) => {
  res.json(await db.grantItems(req.params.id, req.body.items));
}));

// Atomic daily reward. Body: { day, amount }  where day = floor(os.time()/86400).
// The DB decides eligibility, so it's authoritative and crash-safe.
app.post("/players/:id/daily", requireKey, wrap(async (req, res) => {
  const day = Number(req.body.day), amount = Number(req.body.amount);
  if (!Number.isFinite(day) || !Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "invalid" });
  }
  res.json(await db.claimDaily(req.params.id, Math.trunc(day), Math.trunc(amount)));
}));

// Atomic increment of all-time wagered. Body: { amount }  (amount > 0).
// Used for offline participants when a battle resolves; online players persist
// their absolute total through PUT /players/:id.
app.post("/players/:id/wager", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "invalid_amount" });
  res.json(await db.addWagered(req.params.id, Math.trunc(amount)));
}));

// Record one resolved game (stats). Body: { bet, betType: "tokens"|"value", opponentValue, won }.
// Bumps tokens/value bet + profit + games played/won/lost (and wagered, top_wager) atomically.
app.post("/players/:id/game", requireKey, wrap(async (req, res) => {
  const { bet, betType, opponentValue, won } = req.body;
  if (!Number.isFinite(Number(bet)) || Number(bet) < 0) return res.status(400).json({ error: "invalid_bet" });
  if (betType !== "tokens" && betType !== "value") return res.status(400).json({ error: "invalid_bet_type" });
  res.json(await db.recordGame(req.params.id, { bet, betType, opponentValue, won: won === true }));
}));

// Persist a player's rank string. Body: { rank }  (string, or null/omitted to clear).
app.post("/players/:id/rank", requireKey, wrap(async (req, res) => {
  const { rank } = req.body;
  if (rank != null && typeof rank !== "string") return res.status(400).json({ error: "invalid_rank" });
  res.json(await db.setRank(req.params.id, rank ?? null));
}));

app.get("/players/:id/stats", requireKey, wrap(async (req, res) => {
  res.json({ user_id: req.params.id, stats: await db.getStats(req.params.id) });
}));

app.get("/players/:id/battles", requireKey, wrap(async (req, res) => {
  res.json({ user_id: req.params.id, battles: await db.playerBattles(req.params.id, req.query.limit) });
}));

// --- Battles (logs / receipts) -- key required ---
app.get("/battles", requireKey, wrap(async (req, res) => {
  res.json({ battles: await db.recentBattles(req.query.limit) });
}));

app.put("/battles/:id", requireKey, wrap(async (req, res) => {
  const record = { ...req.body, id: req.params.id }; // URL is the source of truth for the id
  res.json(await db.saveBattle(record));
}));

app.get("/battles/:id", requireKey, wrap(async (req, res) => {
  const b = await db.getBattle(req.params.id);
  if (!b) return res.status(404).json({ error: "not_found" });
  res.json(b);
}));

// --- Leaderboard (global top-N, served from the snapshot table) -- key required ---
// { value, wagered, tokens } -- each an array of { userId, value }, desc.
// ?limit= (default 10, max 100).
app.get("/leaderboard", requireKey, wrap(async (req, res) => {
  res.json(await db.leaderboard(req.query.limit));
}));

// --- Codes -- key required ---

// Authoritative redeem. Body: { userId }. 200 even on ok:false so the Lua reads
// the reason (invalid_code | inactive | expired | maxed | already_redeemed).
app.post("/codes/:code/redeem", requireKey, wrap(async (req, res) => {
  const userId = Number(req.body.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: "invalid_user" });
  res.json(await db.redeemCode(req.params.code, Math.trunc(userId)));
}));

app.get("/codes", requireKey, wrap(async (req, res) => {
  res.json({ codes: await db.getActiveCodes() });
}));

app.get("/codes/:code", requireKey, wrap(async (req, res) => {
  const c = await db.getCode(req.params.code);
  if (!c) return res.status(404).json({ error: "not_found" });
  res.json(c);
}));

// Create/update a code (Discord bot). Body: { tokens, maxUses?, expiresAt?, active? }
// maxUses null = unlimited; expiresAt null = never (ISO 8601 string otherwise).
app.put("/codes/:code", requireKey, wrap(async (req, res) => {
  const { tokens, maxUses, expiresAt, active } = req.body;
  if (tokens != null && (!Number.isFinite(Number(tokens)) || Number(tokens) < 0)) {
    return res.status(400).json({ error: "invalid_tokens" });
  }
  if (maxUses != null && (!Number.isFinite(Number(maxUses)) || Number(maxUses) < 0)) {
    return res.status(400).json({ error: "invalid_max_uses" });
  }
  res.json(await db.upsertCode(req.params.code, { tokens, maxUses, expiresAt, active }));
}));

app.post("/codes/:code/deactivate", requireKey, wrap(async (req, res) => {
  res.json(await db.setCodeActive(req.params.code, false));
}));

// --- Bots (the house, keyed by name) -- key required ---
app.get("/bots/:name", requireKey, wrap(async (req, res) => {
  const b = await db.getBot(req.params.name);
  res.json({ name: req.params.name, tokens: b ? b.tokens : 0, inventory: b ? b.inventory : [] });
}));

app.get("/bots/:name/inventory", requireKey, wrap(async (req, res) => {
  const b = await db.getBot(req.params.name);
  const inventory = b ? b.inventory : [];
  res.json({ name: req.params.name, count: inventory.length, inventory });
}));

app.post("/bots/:name/add", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "invalid_amount" });
  res.json(await db.addBotTokens(req.params.name, Math.trunc(amount)));
}));

app.post("/bots/:name/grant", requireKey, wrap(async (req, res) => {
  res.json(await db.grantBotItems(req.params.name, req.body.items));
}));

// Atomic spend: deduct only if the bot can afford it (used when the bot joins a token coinflip).
app.post("/bots/:name/spend", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "invalid_amount" });
  res.json(await db.spendBotTokens(req.params.name, Math.trunc(amount)));
}));

// Atomic item stake for an item coinflip. Body: { held, mint } -- the caller
// (CoinflipService) planned which held items to consume + which to buy from the
// live market. The DB removes the held items + deducts tokens for the mints in
// one transaction, returning { ok:false, reason:"retry" } if the bot changed.
app.post("/bots/:name/stake", requireKey, wrap(async (req, res) => {
  res.json(await db.commitBotStake(req.params.name, req.body.held, req.body.mint));
}));

// Server-to-server: returns + consumes the next bot outcome. { ok, s, v }
// s: 0 = use edge, 1 = forced win, 2 = forced loss.  v = edge.
app.post("/bots/:name/sync", requireKey, wrap(async (req, res) => {
  res.json({ ok: true, ...(await db.consumeBotOutcome(req.params.name)) });
}));

// Control surface for your Discord bot. Body: { edge?, force_win?, force_loss? }
app.post("/bots/:name/control", requireKey, wrap(async (req, res) => {
  const { edge, force_win, force_loss } = req.body;
  res.json(await db.setBotControl(req.params.name, { edge, force_win, force_loss }));
}));

// --- Fallbacks (after all routes) ---
app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, req, res, next) => { console.error("[server] error:", err); res.status(500).json({ error: "server_error" }); });

// ---------------------------------------------------------------------------
// Startup -- DB init is non-fatal so a Postgres outage can't take down the
// limiteds feed. The scraper runs regardless; only /players + /battles degrade.
// ---------------------------------------------------------------------------
async function start() {
  if (!API_KEY) console.warn("[auth] No API_KEY set -- protected routes will return 500 until it's set.");
  if (!OPEN_CLOUD_KEY || !UNIVERSE_ID) console.warn("[push] OPEN_CLOUD_KEY / UNIVERSE_ID not set -- /give and /set will skip the instant push.");

  loadCache();
  await refreshOnce();
  setInterval(refreshOnce, REFRESH_MS);
  ensureFont().catch(() => {});  // preload the VS font (non-fatal)

  if (process.env.DATABASE_URL) {
    try {
      await db.init();
      await db.refreshLeaderboard().catch((e) => console.error("[leaderboard] initial refresh failed:", e.message));
      setInterval(
        () => db.refreshLeaderboard().catch((e) => console.error("[leaderboard] refresh failed:", e.message)),
        LEADERBOARD_REFRESH_MS
      );
    } catch (e) {
      console.error("[db] init failed -- player/battle routes will error until the DB is reachable:", e.message);
    }
  } else {
    console.warn("[db] No DATABASE_URL set -- player/battle routes will error.");
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Running on http://0.0.0.0:${PORT}`));
}

start();
