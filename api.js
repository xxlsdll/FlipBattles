/**
 * limiteds_api.js  (Node.js version)
 * ----------------------------------
 * Same behaviour as the Python one: scrape Rolimon's classic limiteds on a
 * schedule, detect what changed, and serve them as JSON for your Roblox game
 * (HttpService:GetAsync + JSONDecode).
 *
 * Requires Node.js 18 or newer (uses the built-in fetch).
 *
 * Local run:
 *   npm install
 *   node limiteds_api.js
 *
 * Your game fetches:  https://YOUR-APP.up.railway.app/limiteds
 *
 * NEW: also exposes player-token routes backed by Postgres (db.js):
 *   GET  /players/:id        -> { user_id, tokens }      (tokens null if no row)
 *   PUT  /players/:id        -> { user_id, tokens }      (absolute balance save)
 *   POST /players/:id/add    -> { ok, tokens } | { ok:false, reason, tokens }
 * These three are protected by an x-api-key header (see API_KEY env var).
 */

const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./db"); // ADDED: Postgres player-token layer

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

const MIN_VALUE = 10_000;
const MAX_VALUE = 40_000_000;

const REFRESH_MS = 10 * 60 * 1000;   // re-scrape every 10 minutes
const CACHE_FILE = "limiteds_cache.json";
const PORT = process.env.PORT || 8080;   // Railway sets PORT; 8080 locally

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://www.rolimons.com/",
};

// Each item is an array: [Name, Acronym, RAP, Value, ...]
const NAME = 0, RAP = 2, VALUE = 3;

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
let state = {
  items: {},        // { "1028720": { name, headshot, value }, ... }
  version: 0,       // bumps every time the data actually changes
  hash: null,       // fingerprint of the current items
  updatedAt: null,  // ISO timestamp of the last change
  count: 0,
};

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------
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
      {
        name: fields[NAME],
        headshot: `rbxthumb://type=Asset&id=${itemId}&w=150&h=150`,
        value: effective,
      },
    ]);
  }

  items.sort((a, b) => b[1].value - a[1].value);   // most valuable first

  const table = {};
  for (const [id, data] of items) table[String(id)] = data;
  return table;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------
function hashTable(items) {
  const sorted = {};
  for (const k of Object.keys(items).sort()) sorted[k] = items[k];
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function applyUpdate(newItems) {
  const newHash = hashTable(newItems);
  if (newHash === state.hash) return false;   // nothing changed

  const oldItems = state.items;
  const added = Object.keys(newItems).filter((k) => !(k in oldItems));
  const removed = Object.keys(oldItems).filter((k) => !(k in newItems));
  const changed = Object.keys(newItems).filter(
    (k) => k in oldItems && oldItems[k].value !== newItems[k].value
  );

  state.items = newItems;
  state.hash = newHash;
  state.version += 1;
  state.count = Object.keys(newItems).length;
  state.updatedAt = new Date().toISOString();

  saveCache();
  console.log(
    `[update] v${state.version}  total=${state.count}  ` +
    `+${added.length} added  -${removed.length} removed  ~${changed.length} value changes`
  );

  // --- OPTIONAL: push to an API you already run, instead of just serving here ---
  // fetch("https://your-api.example.com/limiteds", {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json", Authorization: "Bearer YOUR_SECRET" },
  //   body: JSON.stringify({ version: state.version, items: newItems }),
  // }).catch((e) => console.error("[push error]", e.message));

  return true;
}

// ---------------------------------------------------------------------------
// Disk cache (instant serve on restart; fallback if a scrape fails)
// ---------------------------------------------------------------------------
function saveCache() {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ version: state.version, items: state.items })
    );
  } catch (e) {
    console.error("[cache write error]", e.message);
  }
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
  } catch {
    // no cache file yet -- that's fine
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
async function refreshOnce() {
  try {
    const table = await scrape();
    if (!applyUpdate(table)) console.log("[refresh] no change");
  } catch (e) {
    console.error(`[scrape error] ${e.message} -- keeping last good data`);
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json()); // ADDED: parse JSON bodies for PUT/POST /players

app.get("/", (req, res) => {
  res.json({
    service: "limiteds-api",
    version: state.version,
    count: state.count,
    updated_at: state.updatedAt,
  });
});

// Cheap endpoint -- your game polls this and only re-pulls /limiteds on a change.
app.get("/version", (req, res) => {
  res.json({ version: state.version, count: state.count, updated_at: state.updatedAt });
});

app.get("/limiteds", (req, res) => {
  res.json({
    version: state.version,
    updated_at: state.updatedAt,
    count: state.count,
    items: state.items,
  });
});

// Original Limiteds.js format, served live. NOTE: Roblox can't use this -- it's
// only for a JavaScript/Node consumer. Your Roblox game uses /limiteds (JSON).
app.get("/limiteds.js", (req, res) => {
  const body = JSON.stringify(state.items, null, 2);
  const js =
    `// Auto-generated live by limiteds_api  --  v${state.version}, updated ${state.updatedAt}\n` +
    `const Limiteds = ${body};\n\n` +
    `if (typeof module !== "undefined" && module.exports) {\n  module.exports = Limiteds;\n}\n`;
  res.type("application/javascript").send(js);
});

app.get("/limiteds/:id", (req, res) => {
  const item = state.items[req.params.id];
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});

// ---------------------------------------------------------------------------
// Player tokens (Postgres via db.js)
// These three routes are protected by an x-api-key header. /limiteds above stays
// public and unchanged -- only the player routes require the key.
//
// IMPORTANT: set an API_KEY variable on this service in Railway equal to the
// exact value of your Roblox GameApiKey. If it's missing, these routes return
// 500; if it doesn't match, they return 401. In both cases your TokensService
// falls back to ProfileStore (source=ProfileStore), so balances stay safe but
// nothing persists to Postgres until the key lines up.
// ---------------------------------------------------------------------------
function requireKey(req, res, next) {
  if (!process.env.API_KEY) {
    console.error("[auth] API_KEY env var is not set -- rejecting /players request");
    return res.status(500).json({ error: "server_misconfigured" });
  }
  if (req.get("x-api-key") !== process.env.API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// GET balance -- 200 {tokens:null} when no row, so Roblox falls back to ProfileStore.
app.get("/players/:id", requireKey, async (req, res) => {
  try {
    const tokens = await db.getTokens(req.params.id);
    res.json({ user_id: req.params.id, tokens });
  } catch (e) {
    console.error("[players GET]", e.message);
    res.status(500).json({ error: "db_error" });
  }
});

// PUT absolute balance (session save / autosave).
app.put("/players/:id", requireKey, async (req, res) => {
  const tokens = Number(req.body.tokens);
  if (!Number.isFinite(tokens)) {
    return res.status(400).json({ error: "invalid_tokens" });
  }
  try {
    const saved = await db.setTokens(req.params.id, tokens);
    res.json({ user_id: req.params.id, tokens: saved });
  } catch (e) {
    console.error("[players PUT]", e.message);
    res.status(500).json({ error: "db_error" });
  }
});

// POST atomic add/spend. Body: { amount, allowNegative }. allowNegative
// defaults to true; send false for purchases so a spend can't go below zero.
app.post("/players/:id/add", requireKey, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) {
    return res.status(400).json({ error: "invalid_amount" });
  }
  try {
    const result = await db.addTokens(req.params.id, amount, req.body.allowNegative !== false);
    res.json(result); // { ok, tokens } or { ok:false, reason, tokens }
  } catch (e) {
    console.error("[players POST add]", e.message);
    res.status(500).json({ error: "db_error" });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  // Create the players table if it doesn't exist yet. Wrapped so that a DB
  // outage at boot doesn't take down the (working) limiteds scraper -- the
  // /players routes will just return errors until Postgres is reachable.
  try {
    await db.init(); // logs "[db] players table ready" on success
  } catch (e) {
    console.error("[db] init failed -- /players routes will error until the DB is reachable:", e.message);
  }

  loadCache();            // serve from last good data if available
  await refreshOnce();    // get fresh data ready before we start serving
  setInterval(refreshOnce, REFRESH_MS);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on http://0.0.0.0:${PORT}`);
  });
}

start();
