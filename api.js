/**
 * limiteds_api.js  (Node.js version)
 * ----------------------------------
 * Scrapes Rolimon's classic limiteds on a schedule and serves them as JSON for
 * your Roblox game, AND exposes player token + inventory routes backed by
 * Postgres (db.js).
 *
 * Requires Node.js 18 or newer (uses the built-in fetch).
 *
 * Local run:
 *   npm install        (express, pg)
 *   node limiteds_api.js
 *
 * Routes:
 *   GET  /limiteds                 -> { version, updated_at, count, items }   (public)
 *   GET  /version                  -> { version, count, updated_at }          (public)
 *   GET  /players/:id              -> { user_id, tokens, inventory }          (key)
 *   PUT  /players/:id              -> { user_id, tokens, inventory }          (key)
 *   POST /players/:id/add          -> { ok, tokens } | { ok:false, reason, tokens }
 *   POST /players/:id/purchase     -> { ok, tokens, inventory } | { ok:false, reason, tokens }
 *   GET  /players/:id/inventory    -> { user_id, count, inventory }           (key)
 */

const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./db"); // Postgres player layer

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
// App + middleware
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// x-api-key guard for the player routes. Set API_KEY on this service in Railway
// equal to your Roblox GameApiKey. 500 if the var is missing (so a misconfig is
// obvious in the logs), 401 if the key doesn't match. Both are non-2xx, so your
// TokensService treats either as "DB unreachable" and stays on ProfileStore.
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

// Async wrapper: a thrown error becomes next(err) -> the error handler -> 500,
// instead of an unhandled rejection.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Limiteds API (public, unchanged)
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    service: "limiteds-api",
    version: state.version,
    count: state.count,
    updated_at: state.updatedAt,
  });
});

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
// Player tokens + inventory (Postgres via db.js) -- protected by x-api-key
// ---------------------------------------------------------------------------

// No row -> 200 with tokens:null so a brand-new player falls through to the
// ProfileStore 100k first-join grant.
app.get("/players/:id", requireKey, wrap(async (req, res) => {
  const p = await db.getPlayer(req.params.id);
  res.json({
    user_id: req.params.id,
    tokens: p ? p.tokens : null,
    inventory: p ? p.inventory : null,
  });
}));

// Absolute save (leave + 5-min autosave). inventory is optional: include the
// array to persist it, omit it to leave the stored inventory untouched.
app.put("/players/:id", requireKey, wrap(async (req, res) => {
  const tokens = Number(req.body.tokens);
  if (!Number.isFinite(tokens)) return res.status(400).json({ error: "invalid_tokens" });
  const p = await db.setPlayer(req.params.id, tokens, req.body.inventory);
  res.json({ user_id: req.params.id, tokens: p.tokens, inventory: p.inventory });
}));

// Atomic add/spend (TrySpend). Body: { amount, allowNegative }.
app.post("/players/:id/add", requireKey, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: "invalid_amount" });
  res.json(await db.addTokens(req.params.id, amount, req.body.allowNegative !== false));
}));

// Atomic purchase: deduct price AND append item in one transaction.
// Body: { price, item }   item = { Id, Name, Value, AcquiredAt }
app.post("/players/:id/purchase", requireKey, wrap(async (req, res) => {
  const price = Number(req.body.price);
  if (!Number.isFinite(price)) return res.status(400).json({ error: "invalid_price" });
  if (req.body.item == null || typeof req.body.item !== "object") {
    return res.status(400).json({ error: "invalid_item" });
  }
  res.json(await db.purchase(req.params.id, price, req.body.item));
}));

// Read-only inventory listing for the website/dashboard.
app.get("/players/:id/inventory", requireKey, wrap(async (req, res) => {
  const inventory = await db.getInventory(req.params.id);
  res.json({ user_id: req.params.id, count: inventory.length, inventory });
}));

// ---------------------------------------------------------------------------
// JSON 404 + error handler (must come after all routes)
// ---------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, req, res, next) => {
  console.error("[server] error:", err);
  res.status(500).json({ error: "server_error" });
});

// ---------------------------------------------------------------------------
// Startup -- DB init is wrapped so a Postgres outage can't take down the
// limiteds feed. The scraper runs regardless; only /players degrades.
// ---------------------------------------------------------------------------
async function start() {
  try {
    await db.init(); // creates/upgrades the players table; logs "[db] players table ready"
  } catch (e) {
    console.error("[db] init failed -- /players routes will error until the DB is reachable:", e.message);
  }

  loadCache();
  await refreshOnce();
  setInterval(refreshOnce, REFRESH_MS);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on http://0.0.0.0:${PORT}`);
  });
}

start();
