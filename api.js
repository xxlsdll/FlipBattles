/**
 * api.js  (Node.js)
 * -----------------
 * Scrapes Rolimon's classic limiteds on a schedule and serves them as JSON.
 * Optionally protected by an API key set via the API_KEY environment variable
 * (set this in Railway -> your service -> Variables).
 *
 * Requires Node.js 18+.
 *
 * Local run:
 *   npm install
 *   node api.js
 *   (to test auth locally on Windows PowerShell:  $env:API_KEY="test"; node api.js)
 */

const express = require("express");
const fs = require("fs");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ITEM_DETAILS_URL = "https://www.rolimons.com/itemapi/itemdetails";

const MIN_VALUE = 10_000;
const MAX_VALUE = 40_000_000;

const REFRESH_MS = 10 * 60 * 1000;   // re-scrape every 10 minutes
const CACHE_FILE = "limiteds_cache.json";
const PORT = process.env.PORT || 8080;

// Set this in Railway -> Variables. If left empty, the API is OPEN (no key).
const API_KEY = process.env.API_KEY || "";

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
  items: {},
  version: 0,
  hash: null,
  updatedAt: null,
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
    const effective = value === -1 ? rap : value;

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

  items.sort((a, b) => b[1].value - a[1].value);

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
  if (newHash === state.hash) return false;

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
// Disk cache
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
    // no cache yet -- fine
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
// Auth
// ---------------------------------------------------------------------------
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;          // length check avoids throw
  return crypto.timingSafeEqual(ab, bb);
}

// Middleware: if API_KEY is configured, require a matching x-api-key header.
function requireKey(req, res, next) {
  if (!API_KEY) return next();                         // no key set -> open
  const provided = req.get("x-api-key");
  if (provided && safeEqual(provided, API_KEY)) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();

// Open health check (no item data exposed) -- handy for testing the deploy.
app.get("/", (req, res) => {
  res.json({
    service: "limiteds-api",
    version: state.version,
    count: state.count,
    updated_at: state.updatedAt,
    auth: API_KEY ? "enabled" : "open",
  });
});

// Everything below requires the key (when one is set).
app.get("/version", requireKey, (req, res) => {
  res.json({ version: state.version, count: state.count, updated_at: state.updatedAt });
});

app.get("/limiteds", requireKey, (req, res) => {
  res.json({
    version: state.version,
    updated_at: state.updatedAt,
    count: state.count,
    items: state.items,
  });
});

app.get("/limiteds.js", requireKey, (req, res) => {
  const body = JSON.stringify(state.items, null, 2);
  const js =
    `// v${state.version}, updated ${state.updatedAt}\n` +
    `const Limiteds = ${body};\n\n` +
    `if (typeof module !== "undefined" && module.exports) {\n  module.exports = Limiteds;\n}\n`;
  res.type("application/javascript").send(js);
});

app.get("/limiteds/:id", requireKey, (req, res) => {
  const item = state.items[req.params.id];
  if (!item) return res.status(404).json({ error: "not found" });
  res.json(item);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  if (!API_KEY) {
    console.warn("[auth] No API_KEY set -- the API is OPEN. Set API_KEY in Railway to lock it down.");
  } else {
    console.log("[auth] API key required.");
  }

  loadCache();
  await refreshOnce();
  setInterval(refreshOnce, REFRESH_MS);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Running on http://0.0.0.0:${PORT}`);
  });
}

start();
