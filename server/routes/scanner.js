import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ─────────────────────────────────────────────────────────────
// COST TELEMETRY — track tokens and estimated $ per scan.
// Haiku 4.5 pricing (update if Anthropic changes rates).
// ─────────────────────────────────────────────────────────────
const PRICING = {
  'claude-haiku-4-5':           { in: 0.80 / 1e6, out:  4.00 / 1e6 },
  'claude-haiku-4-5-20251001':  { in: 0.80 / 1e6, out:  4.00 / 1e6 },
  'claude-sonnet-4-6':          { in: 3.00 / 1e6, out: 15.00 / 1e6 },
};
const WEB_SEARCH_TOOL_COST = 0.01; // approx per-search tool fee

// Daily analysis spend ceiling (hard stop). The cost tracker is known to
// undercount real billing ~2x, so we charge searches against the budget at 2x
// the estimate — this keeps REAL spend at or under the cap (may under-spend).
const DAILY_BUDGET_USD = 3.00;
const COST_UNDERCOUNT_FACTOR = 2;
// Conservative per-search cost charged against the daily budget: tool fee plus a
// typical search's token cost, all doubled. ~ (0.01 + ~0.01 tokens) * 2 ≈ $0.04.
const BUDGETED_SEARCH_COST = (WEB_SEARCH_TOOL_COST + 0.01) * COST_UNDERCOUNT_FACTOR;

function makeCostTracker() {
  return {
    classifyCalls: 0, classifyInTok: 0, classifyOutTok: 0,
    searchCalls: 0, searchRequests: 0, searchInTok: 0, searchOutTok: 0, searchCacheHits: 0,
    imagesFullRes: 0, imagesThumb: 0, imagesFailed: 0,
    itemsClassified: 0, itemsSearched: 0, itemsHeuristic: 0, itemsAiPriced: 0,
  };
}

function logUsage(tracker, model, usage, kind) {
  if (!usage) return;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  if (kind === 'classify') {
    tracker.classifyCalls++;
    tracker.classifyInTok += inTok;
    tracker.classifyOutTok += outTok;
  } else if (kind === 'search') {
    tracker.searchCalls++;
    tracker.searchRequests += (usage.server_tool_use?.web_search_requests || 0);
    tracker.searchInTok += inTok;
    tracker.searchOutTok += outTok;
  }
}

function estCost(tracker) {
  const cs = PRICING['claude-sonnet-4-6'];
  const ch = PRICING['claude-haiku-4-5'];
  const classify = tracker.classifyInTok * cs.in + tracker.classifyOutTok * cs.out;
  const searchTok = tracker.searchInTok * ch.in + tracker.searchOutTok * ch.out;
  const searchTool = (tracker.searchRequests || tracker.searchCalls) * WEB_SEARCH_TOOL_COST;
  return {
    classify,
    search: searchTok + searchTool,
    searchTokens: searchTok,
    searchTool,
    total: classify + searchTok + searchTool,
  };
}

// ── Daily spend budget (hard $ ceiling, resets midnight PT) ──
// Returns today's PT calendar date as YYYY-MM-DD.
function pacificDay() {
  // en-CA formats as YYYY-MM-DD; the timeZone shifts to Pacific.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Read how much we've already spent (budgeted estimate) today.
async function getTodaySpend() {
  const day = pacificDay();
  const { data } = await supabase
    .from('daily_spend').select('spent').eq('day', day).maybeSingle();
  return data ? Number(data.spent) || 0 : 0;
}

// Add to today's spend total (upsert).
async function addTodaySpend(amount) {
  const day = pacificDay();
  const current = await getTodaySpend();
  await supabase.from('daily_spend').upsert({
    day, spent: current + amount, updated_at: new Date().toISOString(),
  }, { onConflict: 'day' });
}


function printCostReport(tracker, affiliateId, newCount) {
  const cost = estCost(tracker);
  const pct = (n) => cost.total > 0 ? ((n / cost.total) * 100).toFixed(0) : '0';
  console.log(`
╔══════════════════════════════════════════════════════════════
║ COST REPORT — affiliate ${affiliateId}
╠══════════════════════════════════════════════════════════════
║ Items: ${newCount} new analyzed
║   classified:        ${tracker.itemsClassified}
║   comp-searched:     ${tracker.itemsSearched}
║   AI-priced (no search): ${tracker.itemsAiPriced}
║   heuristic-priced:  ${tracker.itemsHeuristic}
║
║ Images:
║   full-res fetched:  ${tracker.imagesFullRes}
║   thumbnail only:    ${tracker.imagesThumb}
║   failed:            ${tracker.imagesFailed}
║
║ CLASSIFY (vision):
║   calls:             ${tracker.classifyCalls}
║   input tokens:      ${tracker.classifyInTok.toLocaleString()}
║   output tokens:     ${tracker.classifyOutTok.toLocaleString()}
║   cost:              $${cost.classify.toFixed(4)}  (${pct(cost.classify)}%)
║
║ WEB SEARCH (comps):
║   calls (items):     ${tracker.searchCalls}
║   web_search reqs:   ${tracker.searchRequests}  (avg ${tracker.searchCalls ? (tracker.searchRequests / tracker.searchCalls).toFixed(1) : 0}/item)
║   cache hits saved:  ${tracker.searchCacheHits}
║   input tokens:      ${tracker.searchInTok.toLocaleString()}
║   output tokens:     ${tracker.searchOutTok.toLocaleString()}
║   token cost:        $${cost.searchTokens.toFixed(4)}
║   tool fee:          $${cost.searchTool.toFixed(4)}
║   cost:              $${cost.search.toFixed(4)}  (${pct(cost.search)}%)
║
║ ─────────────────────────────────────────
║ TOTAL EST COST:      $${cost.total.toFixed(4)}
║ avg per new item:    $${newCount > 0 ? (cost.total / newCount).toFixed(4) : '0'}
╚══════════════════════════════════════════════════════════════`);
}

const BIDRL_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.bidrl.com',
  'Referer': 'https://www.bidrl.com/',
};

// Fetch all items for an affiliate
async function fetchAllItems(affiliateId) {
  const baseBody = `filters%5Baffiliates%5D=${affiliateId}`;
  const firstRes = await fetch('https://www.bidrl.com/api/getitems', {
    method: 'POST', headers: BIDRL_HEADERS, body: baseBody,
  });
  const firstData = await firstRes.json();
  const totalPages = firstData.total_pages || 1;
  let rawItems = firstData.items || [];
  console.log(`[Scan] Affiliate ${affiliateId}: ${firstData.total} items, ${totalPages} pages`);

  for (let p = 2; p <= totalPages; p += 5) {
    const batch = [];
    for (let bp = p; bp < Math.min(p + 5, totalPages + 1); bp++) {
      batch.push(
        fetch('https://www.bidrl.com/api/getitems', {
          method: 'POST', headers: BIDRL_HEADERS,
          body: baseBody + `&filters%5Bpage%5D=${bp}`,
        }).then(r => r.json()).then(d => d.items || []).catch(() => [])
      );
    }
    rawItems = rawItems.concat((await Promise.all(batch)).flat());
  }

  return [...new Map(
    rawItems.filter(i => i.lot_number && i.title && i.title.length > 3)
    .map(i => {
      // BidRL HTML-encodes titles: 2&#34; -> 2", &#38; -> &, etc. Decode at the
      // boundary so the DB, AI prompt, and Facebook caption all see clean text
      // (real " and ' marks for measurements like 6' tall / 20" wide).
      i.title = decodeHtmlEntities(i.title);
      if (i.auction_title) i.auction_title = decodeHtmlEntities(i.auction_title);
      return [i.lot_number, i];
    })
  ).values()];
}

// Decode the HTML entities BidRL emits in listing titles. Covers numeric
// (&#34; &#39; &#160;), hex (&#x22;), and the common named entities. This is
// intentionally small and dependency-free — it only needs to handle what
// BidRL actually sends, not arbitrary HTML.
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    // numeric decimal: &#34; -> "
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    // numeric hex: &#x22; -> "
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // common named entities
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // &amp; LAST so we don't double-decode things like &amp;#34;
    .replace(/&amp;/g, '&');
}

// Per-lot TRUE end epoch. BidRL returns two fields: `ends` (the auction's BASE
// close, identical for every lot) and `end_time` (this lot's STAGGERED close —
// lots close 45-60s apart in sequence). Storing `ends` made late-sequence lots
// show up to ~45 min less time than reality; always prefer `end_time`. Both are
// raw values needing the +7200 correction (verified against BidRL's displayed
// close times).
function trueEndsAt(item) {
  const raw = parseInt(item.end_time) || parseInt(item.ends) || 0;
  return raw ? raw + 7200 : null;
}

// Convert a BidRL thumbnail URL to full resolution
// Thumbnails end in _t.jpg; full-size drops the _t suffix
function toFullResUrl(url) {
  if (!url) return null;
  // e.g. .../wIMG_20260610_090559842_HDR_t.jpg -> .../wIMG_20260610_090559842_HDR.jpg
  return url.replace(/_t(\.[a-zA-Z]+)(\?.*)?$/, '$1$2');
}

// Thumbnail-only fetch for CLASSIFICATION. A ~320px thumb costs ~10x fewer
// image tokens than full-res, and ID quality holds because the description text
// (product name, retailer link) now carries most of the identification signal.
async function fetchThumbBase64(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 5_000_000) return null;
    return { base64: Buffer.from(buffer).toString('base64'), mediaType: contentType.split(';')[0], res: 'thumb' };
  } catch { return null; }
}

// Strip HTML tags + entities from a BidRL description for the classify prompt.
function stripHtmlText(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Fetch image as base64 — tries full-res first, falls back to thumbnail
// Returns { base64, mediaType, res: 'full'|'thumb' } or null
async function fetchImageBase64(url) {
  const tryFetch = async (u) => {
    try {
      const res = await fetch(u, { timeout: 8000 });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const buffer = await res.arrayBuffer();
      // Skip absurdly large images (>5MB) to stay within model limits
      if (buffer.byteLength > 5_000_000) return null;
      return { base64: Buffer.from(buffer).toString('base64'), mediaType: contentType.split(';')[0] };
    } catch { return null; }
  };

  const fullRes = toFullResUrl(url);
  if (fullRes && fullRes !== url) {
    const full = await tryFetch(fullRes);
    if (full) return { ...full, res: 'full' };
  }
  const thumb = await tryFetch(url);
  return thumb ? { ...thumb, res: 'thumb' } : null;
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — CLASSIFIER (no pricing). Extract structured tags only.
// AI is used here purely to identify and label, never to value.
// ─────────────────────────────────────────────────────────────
// JSON schema for structured outputs — guarantees the classifier returns valid,
// parseable JSON so a single stray character can never drop a whole batch.
const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lots'],
  properties: {
    lots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lotId','category','subtype','brand','model','sizeClass','keywords','condition','estResale','priceConfidence','idConfidence'],
        properties: {
          lotId: { type: 'string' },
          category: { type: 'string', enum: ['electronics','appliance_large','appliance_small','furniture','tools','sporting_goods','gym_equipment','outdoor','toys','kitchenware','home_goods','apparel','health_beauty','automotive','media','collectible','bulk_lot','other'] },
          subtype: { type: 'string' },
          brand: { type: ['string','null'] },
          model: { type: ['string','null'] },
          sizeClass: { type: 'string', enum: ['small','medium','large'] },
          keywords: { type: 'array', items: { type: 'string' } },
          condition: { type: 'string', enum: ['new','open_box','used_good','used_fair'] },
          estResale: { type: 'number' },
          priceConfidence: { type: 'string', enum: ['high','medium','low'] },
          idConfidence: { type: 'string', enum: ['high','medium','low'] },
        },
      },
    },
  },
};

// Robustly pull the lots array out of a classify response — handles the structured
// {"lots":[...]} shape, a bare [...] (fallback path), and salvages a truncated
// array rather than dropping the whole batch.
function parseClassify(message) {
  const txt = (message.content.find(b => b.type === 'text')?.text || '').replace(/```json|```/g, '').trim();
  try { const p = JSON.parse(txt); if (Array.isArray(p)) return p; if (Array.isArray(p?.lots)) return p.lots; } catch {}
  const start = txt.indexOf('[');
  if (start >= 0) {
    const frag = txt.slice(start);
    const last = frag.lastIndexOf('}');
    if (last > 0) { try { return JSON.parse(frag.slice(0, last + 1) + ']'); } catch {} }
  }
  return [];
}

async function classifyItems(items, imageData, tracker) {
  const lotsText = items.map(item => {
    const cleanTitle = item.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    const auctionHint = item.auction_title ? ` [Auction: ${item.auction_title.slice(0, 60)}]` : '';
    // Description often names the exact product (retailer link) AND notes
    // damage/missing parts that the box photo hides. Cheap text tokens, high signal.
    const desc = stripHtmlText(item.description).slice(0, 220);
    return `${item.lot_number}: ${cleanTitle}${auctionHint}${desc ? ` [Desc: ${desc}]` : ''}`;
  }).join('\n');

  const contentBlocks = [{
    type: 'text',
    text: `You are an expert product identifier for a resale/liquidation business. Your ONLY job is to identify and classify each item. DO NOT estimate prices — another system handles pricing.

For each lot, use the image (primary for identification) and the title + auction title (primary for condition) to extract structured data.

IDENTIFICATION RULES:
- READ ALL TEXT visible on boxes, packaging, labels — brand and model are often printed there
- The image is your best tool for identifying brand, model, and exact variant
- A generic title like "Coffee Machine" with an image clearly showing a Breville Barista Express should be identified as Breville Barista Express
- Capture dimensions/size when visible — they massively affect value (a 14ft frame pool vs a kiddie pool)
- CRITICAL for size-variant products (rugs, tarps, canopies, shelving, pools, gazebos, tents, curtains, blinds): ALWAYS include the exact dimensions from the title in the 'model' field. The same product name at 2'x3' vs 8'x10' can differ 10x in price. Example: "Rugs.com Zermatt Shag 2'x3'" → model: "Zermatt Shag 2x3", NOT just "Zermatt Shag". If you omit the size, search results will mix all sizes and produce a wildly wrong price.

CONDITION RULES (priority order):
1. Title keywords first: NEW/SEALED/NIB → new; OPEN BOX/OPENED → open_box; USED/AS-IS/DAMAGED/PARTS → used_fair; GENTLY USED/REFURBISHED → used_good
2. [Desc: ...] text: damage / broken / cracked / missing / incomplete / as-is / untested notes OVERRIDE a clean box photo → used_fair (and lower estResale accordingly)
3. Later photos: you may get SEVERAL photos per lot — the first is usually the sealed box or product shot; the following photos show the actual item and its condition. Damage, missing pieces, or heavy wear visible in ANY later photo means used_fair, even if the first photo looks new. NEVER call a lot "new" from the box shot alone when a later photo contradicts it.
4. Auction title patterns: "returns"/"dot com"/"overstock" → likely new; "undeliverable"/"variety" → likely open_box; "liquidation"/"salvage"/"estate" → likely used
5. First image only if nothing above gives a signal

CATEGORY: pick the single best fit from:
electronics, appliance_large, appliance_small, furniture, tools, sporting_goods, gym_equipment, outdoor, toys, kitchenware, home_goods, apparel, health_beauty, automotive, media, collectible, bulk_lot, other

${lotsText}

Return a JSON object with a "lots" array — one entry per lot, in the same order:
{"lots":[{"lotId":"RD1234","category":"outdoor","subtype":"rectangular frame pool","brand":"Intex","model":"14ft x 8ft x 3ft","sizeClass":"large","keywords":["pool","frame","14ft"],"condition":"new","estResale":230,"priceConfidence":"high","idConfidence":"high"}]}

estResale: your best estimate of the item's USED resale value in dollars on Facebook Marketplace, given its condition. A whole number.
priceConfidence: how sure you are of estResale. Be honest and conservative — only use "high" when you genuinely know what this item sells for. "high" = either a clearly-identified product whose resale value you know well (known brand+model), OR a generic item in a category with a tight, predictable used price (e.g. a standard 6-drawer dresser). "medium" = recognizable but value varies a lot by model/spec you can't fully pin down. "low" = you are essentially guessing. If you cannot tell exactly what the item is AND its category price varies widely, you must use "low" — do not claim high price confidence for an item you can't identify.
idConfidence: high = brand+model clearly identified; medium = category+subtype clear, brand uncertain; low = generic/unclear.
brand/model may be null if genuinely not identifiable. sizeClass: small|medium|large.`
  }];

  items.forEach((item, i) => {
    const photos = imageData[i] || [];
    photos.forEach((img, j) => {
      contentBlocks.push({ type: 'text', text: `Photo ${j + 1} for ${item.lot_number}:` });
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    });
  });

  const maxTok = Math.min(150 * items.length + 300, 4096);
  let message;
  try {
    // Structured outputs → guaranteed valid JSON matching CLASSIFY_SCHEMA.
    message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTok,
      messages: [{ role: 'user', content: contentBlocks }],
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    });
  } catch (e) {
    // Fail safe: if structured outputs is rejected for any reason, fall back to the
    // plain call (the prompt already requests the same shape) so scans never stall.
    console.error('[Scan] classify structured-output failed, falling back to plain:', e.message);
    message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTok,
      messages: [{ role: 'user', content: contentBlocks }],
    });
  }
  if (tracker) logUsage(tracker, 'claude-sonnet-4-6', message.usage, 'classify');
  return parseClassify(message);
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — COMP LOOKUP. Returns {retail, resale} from real listings.
// For branded items: search the product. For generic high-value
// items: search the category + size + "used sold price".
// ─────────────────────────────────────────────────────────────
// In-memory cache (fast, within a single run) layered over a persistent
// DB cache (survives restarts/deploys). Results are reused for CACHE_TTL_DAYS
// so the same product is never web-searched twice within the window — even if
// the server redeploys mid-auction. This is the primary cost control.
const searchCache = new Map();
const CACHE_TTL_DAYS = 21;

async function readPersistentCache(key) {
  try {
    const { data } = await supabase
      .from('comp_cache')
      .select('median, is_generic, data_points, updated_at')
      .eq('query_key', key)
      .maybeSingle();
    if (!data) return undefined; // not cached
    // Check freshness
    const ageMs = Date.now() - new Date(data.updated_at).getTime();
    if (ageMs > CACHE_TTL_DAYS * 86400000) return undefined; // stale → re-search
    // Cached "no result" is stored as median null
    if (data.median === null) return null;
    return { median: data.median, isGeneric: data.is_generic, count: data.data_points };
  } catch {
    return undefined; // on any error, treat as cache miss
  }
}

async function writePersistentCache(key, result) {
  try {
    await supabase.from('comp_cache').upsert({
      query_key: key,
      median: result ? result.median : null,
      is_generic: result ? result.isGeneric : false,
      data_points: result ? result.count : 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'query_key' });
  } catch (e) {
    console.error('[Scan] comp_cache write error:', e.message);
  }
}

// Regex that matches dimension patterns like 2'x3', 5x8, 8'x10", 2.5x4 ft, 30x60in
const DIM_RE = /\b\d+(?:[''"]|\.\d+)?\s*[x×]\s*\d+(?:[''"]|\s*(?:ft|feet|in|inch|cm|m\b))?/i;

function hasDimension(str) {
  return DIM_RE.test(str);
}

function extractDimension(title) {
  const m = title.match(DIM_RE);
  return m ? m[0].trim() : null;
}

function buildSearchQuery(tag) {
  const brand = tag.brand || '';
  let model = tag.model || '';

  // If the model is missing a size and the original title has one, append it.
  // This catches size-variant products (rugs, pools, tarps, shelving) where the
  // classifier returned only the product name and dropped the dimensions.
  if (brand && model && !hasDimension(model) && tag._title) {
    const dim = extractDimension(tag._title);
    if (dim) model = `${model} ${dim}`.trim();
  }

  if (brand && model) return `${brand} ${model}`.trim();
  // Generic high-value item: build a descriptive category query
  const parts = [tag.subtype || tag.category, tag.sizeClass !== 'medium' ? tag.sizeClass : ''].filter(Boolean);
  return parts.join(' ').trim();
}

async function searchComps(tag, tracker) {
  const queryBase = buildSearchQuery(tag);
  if (!queryBase) return null;
  const key = queryBase.toLowerCase();

  // Layer 1: in-memory cache (this run)
  if (searchCache.has(key)) {
    if (tracker) tracker.searchCacheHits++;
    return searchCache.get(key);
  }

  // Layer 2: persistent DB cache (survives restarts/deploys)
  const persisted = await readPersistentCache(key);
  if (persisted !== undefined) {
    if (tracker) tracker.searchCacheHits++;
    searchCache.set(key, persisted); // promote into in-memory layer
    return persisted;
  }

  const isGeneric = !(tag.brand && tag.model);
  const prompt = isGeneric
    ? `Search Facebook Marketplace, eBay SOLD listings, and Craigslist for what a "${queryBase}" (condition: ${tag.condition || 'used'}) ACTUALLY SELLS FOR used locally. Ignore brand-new retail prices, shipping costs, and unrelated items — focus on realized USED sale prices.

When done, reply with ONLY this JSON object and nothing else:
{"used_resale_usd": <typical used selling price as a number, or null if unknown>, "retail_usd": <new retail price as a number, or null>, "comp_count": <how many real price data points you found>, "confidence": "high|medium|low"}`
    : `Search for the "${queryBase}". Find (1) the current NEW retail price (Amazon/Walmart) and (2) the typical USED resale value from eBay SOLD listings or Facebook Marketplace. Ignore shipping costs and unrelated items.

When done, reply with ONLY this JSON object and nothing else:
{"retail_usd": <current new retail price as a number, or null>, "used_resale_usd": <typical used resale price as a number, or null>, "comp_count": <how many real price data points you found>, "confidence": "high|medium|low"}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: prompt }],
    });
    if (tracker) logUsage(tracker, 'claude-haiku-4-5-20251001', resp.usage, 'search');

    // Separate the model's own text (holds the JSON summary) from raw search-result
    // text (used only as a regex fallback).
    let modelText = '', toolText = '';
    for (const b of resp.content) {
      if (b.type === 'text') modelText += ' ' + b.text;
      else if (b.type === 'web_search_tool_result') {
        if (typeof b.content === 'string') toolText += ' ' + b.content;
        else if (Array.isArray(b.content)) toolText += ' ' + b.content.map(c => c.text || '').join(' ');
      }
    }

    // Primary: trust the model's synthesized number — it can tell a sold comp from
    // a retail/shipping/unrelated price, which a blind $-scrape cannot.
    // priceFromComps expects: generic median = used resale; branded median = retail
    // (it then condition-converts). Preserve that contract.
    let median = null, count = 0, confidence = null;
    const jm = modelText.match(/\{[\s\S]*\}/);
    if (jm) {
      try {
        const p = JSON.parse(jm[0]);
        const retail = Number(p.retail_usd) || 0;
        const used = Number(p.used_resale_usd) || 0;
        count = parseInt(p.comp_count) || 0;
        confidence = ['low','medium','high'].includes(p.confidence) ? p.confidence : null;
        const pick = isGeneric ? (used || retail) : (retail || used);
        if (pick > 0) median = pick;
      } catch {}
    }

    // Fallback: if the model gave no usable number, scrape prices from the raw search
    // text (old behavior) so a parse miss never loses comp data.
    if (median === null) {
      const prices = [...(modelText + ' ' + toolText).matchAll(/\$([0-9,]+(?:\.[0-9]{1,2})?)/g)]
        .map(m => parseFloat(m[1].replace(/,/g, '')))
        .filter(p => p > 3 && p < 15000)
        .sort((a, b) => a - b);
      if (prices.length) {
        let trimmed = prices;
        if (prices.length >= 6) {
          const cut = Math.floor(prices.length * 0.1);
          trimmed = prices.slice(cut, prices.length - cut);
        }
        const mid = Math.floor(trimmed.length / 2);
        median = trimmed.length % 2 === 0 ? (trimmed[mid - 1] + trimmed[mid]) / 2 : trimmed[mid];
        count = prices.length;
      }
    }

    if (median === null || median <= 0) {
      searchCache.set(key, null);
      await writePersistentCache(key, null); // remember the miss so we don't re-search
      return null;
    }

    const result = { median: Math.round(median), isGeneric, count: count || 1, confidence };
    console.log(`[Scan] Comps "${queryBase}" → $${result.median} (${count} pts${confidence ? ', ' + confidence : ''})`);
    searchCache.set(key, result);
    await writePersistentCache(key, result);
    return result;
  } catch (e) {
    console.error('[Scan] Comp search error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — ROUTER + PRICING. Decide per-item how to price it.
//   branded            → comp lookup on the product
//   generic high-value → category comp lookup ("used X sold price")
//   low-value/unclear  → skip search, use conservative heuristic
// Condition adjusts which comps we trust, not a blind multiplier.
// ─────────────────────────────────────────────────────────────

// Rough retail anchors by category for when we have NO comps and NO
// brand — used only as a last-resort floor so generic high-value items
// (furniture, pool tables) don't collapse to near-zero.
const CATEGORY_RETAIL_ANCHOR = {
  furniture: 200, gym_equipment: 250, appliance_large: 350, appliance_small: 80,
  electronics: 120, tools: 90, sporting_goods: 80, outdoor: 150, toys: 35,
  kitchenware: 50, home_goods: 45, apparel: 30, health_beauty: 35,
  automotive: 70, media: 20, collectible: 60, bulk_lot: 60, other: 50,
};
const SIZE_MULT = { small: 0.7, medium: 1.0, large: 1.8 };

// Decide whether an item is worth a (paid) comp search.
// We trust the AI's own price estimate ONLY when:
//   - it's confident about BOTH identity and price, AND
//   - the item is clearly branded (brand+model known), AND
//   - the estimate is low enough that an over-valuation can't cause a bad bid.
// Evidence showed the AI anchors toward NEW RETAIL for mid-range tools/appliances
// and badly over-values generic large items (a $60 fan estimated at $347). So we
// verify with a search whenever the stakes (value) or ambiguity (generic) are high.
// For fully-identified branded items (idSure + priceSure), the AI's own estimate
// is reliable up to $150. Generic/uncertain items stay at the original $80 ceiling
// because those are where the worst over-valuations historically occurred.
const AI_TRUST_CEILING_BRANDED = 150;
const AI_TRUST_CEILING_GENERIC  = 80;

// Categories where web search adds little value: items are too variable
// (collectibles, apparel) or too cheap/unsellable locally (media, health_beauty)
// to justify the search cost. Heuristic or AI estimate is sufficient.
const NO_SEARCH_CATEGORIES = new Set(['apparel', 'media', 'health_beauty', 'collectible']);

// Categories that don't realistically resell locally (per BidRL cofounder):
// bulky install-it fixtures and window treatments get listed but almost never
// sell used, so comp/AI prices wildly overstate them. Matched against the title
// plus the classifier's subtype/keywords; final resale is cut 90%. NOTE: bare
// "tub" is deliberately NOT matched — storage tubs/totes DO sell.
const LOW_DEMAND_MULT = 0.1;
const LOW_DEMAND_RE = /\b(bath\s?tubs?|freestanding tubs?|soaking tubs?|garden tubs?|tub surrounds?|shower (doors?|pans?|bases?|walls?|surrounds?|stalls?|enclosures?)|toilets?|bidets?|blinds?|shades?|window treatments?|shutters?|curtain rods?)\b/i;
function isLowDemand(tag) {
  const hay = [tag?._title, tag?.subtype, ...(Array.isArray(tag?.keywords) ? tag.keywords : [])]
    .filter(Boolean).join(' ');
  return LOW_DEMAND_RE.test(hay);
}

// A lot that is only PART of a multi-box/multi-piece item — "1 of 2 boxes",
// "box 2 of 3", "part 1 of 2", "2 of 2 cartons". A single box can't be resold as a
// complete item, so its resale value is ~$0; pricing it as a whole item creates
// false fire deals. Detected from the title and zeroed out when building results.
const PARTIAL_LOT_RE = /\b(?:box|boxes|part|parts|piece|pieces|pc|pcs|carton|cartons|ctn)\s*\d+\s*of\s*\d+\b|\b\d+\s*of\s*\d+\s*(?:box|boxes|part|parts|piece|pieces|pc|pcs|carton|cartons|ctn)\b/i;
function isPartialLot(title) { return !!title && PARTIAL_LOT_RE.test(title); }

function shouldSearch(tag) {
  if (!tag) return false;
  // Don't spend a comp search on a partial/multi-box lot — it gets zeroed anyway.
  if (isPartialLot(tag._title)) return false;
  // Nor on low-demand fixtures/window treatments — the value gets cut 90% anyway.
  if (isLowDemand(tag)) return false;
  const est = Number(tag.estResale) || 0;
  const isBranded = !!(tag.brand && tag.model);

  // If AI couldn't identify the item, the search query will be vague and return
  // scattered prices no better than the heuristic — skip the expense.
  if (tag.idConfidence === 'low') return false;

  // Low-resale or high-variability categories: comps don't reliably price these.
  if (NO_SEARCH_CATEGORIES.has(tag.category)) return false;

  // Generic items (no clear brand+model) are where the worst over-valuations
  // happen — always verify unless they're cheap enough not to matter.
  if (!isBranded) {
    return est >= 40 || ['furniture', 'gym_equipment', 'appliance_large', 'outdoor'].includes(tag.category);
  }

  // Branded items: trust the AI when it's confident on both identity and price.
  // Raise the ceiling to $150 for fully-identified items — the AI's knowledge of
  // common branded products (tools, appliances, electronics) is reliable up to
  // that range, and a search would only confirm what we already know.
  const idSure = tag.idConfidence === 'high';
  const priceSure = tag.priceConfidence === 'high';
  const ceiling = (idSure && priceSure) ? AI_TRUST_CEILING_BRANDED : AI_TRUST_CEILING_GENERIC;
  if (idSure && priceSure && est < ceiling) return false;

  // Otherwise verify if it's worth enough to matter.
  return est >= 40;
}

// A thin comp (single data point or low confidence) can grab a new-retail or
// unrelated price, so it is guarded — but only against INFLATION. We cap it at this
// multiple of the classifier's own estResale instead of snapping it DOWN to that
// estimate. Snapping down (the old est*0.85 cap) dragged legitimately-higher comps
// onto the same round anchor, so unrelated items collapsed to identical prices.
const THIN_COMP_CEILING = 1.3;

// Convert a comp result + condition into a final FB resale number.
function priceFromComps(comp, tag) {
  if (!comp || !comp.median) return null;
  let resale;
  // Generic comps are already "used sold" prices; hedge against retail/asking-price
  // contamination (overpaying is worse for a reseller than missing a deal).
  if (comp.isGeneric) {
    resale = comp.median * 0.85;
  } else {
    // Branded comps are retail-anchored; convert to local FB resale by condition.
    const cond = (tag.condition || 'used_good');
    let factor;
    if (cond.includes('new')) factor = 0.62;
    else if (cond.includes('open')) factor = 0.55;
    else if (cond.includes('good')) factor = 0.48;
    else factor = 0.32; // used_fair / damaged
    resale = comp.median * factor;
  }
  // Thin-data guard (anti-inflation only): a single data point (count<=1) or a
  // low-confidence search skews HIGH — a lone comp can be a new-retail or unrelated
  // price. Cap it at THIN_COMP_CEILING × the classifier's estResale so an inflated
  // comp can't drive a bad bid — but DON'T snap it down to the estimate, which would
  // pull reasonable comps onto a shared round anchor (unrelated items → identical $).
  const thin = (comp.count || 0) <= 1 || comp.confidence === 'low';
  if (thin) {
    const aiEst = Number(tag.estResale) || 0;
    resale = aiEst > 0 ? Math.min(resale, aiEst * THIN_COMP_CEILING) : resale * 0.8;
  }
  return Math.round(resale);
}

// Last-resort heuristic when we have no comps at all.
function priceFromHeuristic(tag) {
  const anchor = (CATEGORY_RETAIL_ANCHOR[tag.category] || 50) * (SIZE_MULT[tag.sizeClass] || 1);
  const cond = (tag.condition || 'used_good');
  let factor;
  if (cond.includes('new')) factor = 0.55;
  else if (cond.includes('open')) factor = 0.48;
  else if (cond.includes('good')) factor = 0.40;
  else factor = 0.25;
  return Math.round(anchor * factor);
}

async function analyzeBatchWithVision(items, tracker) {
  // ALL photos per lot except the trailing lot-tag shot (useless), capped at 6
  // as a cost guard: photo 1 is the box/product shot; the rest show the actual
  // contents and condition wherever the damage appears in the sequence
  // (first-image-only classification priced damaged goods as new). Thumbnails
  // keep this cheaper than the old single full-res image (~10x fewer tokens each).
  const imageData = await Promise.all(
    items.map(async (item) => {
      const imgs = Array.isArray(item.images) ? item.images : [];
      const usable = imgs.length > 1 ? imgs.slice(0, -1) : imgs; // drop the tag photo
      const urls = usable.slice(0, 6).map(im => im.thumb_url || im.image_url).filter(Boolean);
      if (urls.length === 0 && (item.thumb_url || item.image_url)) urls.push(item.thumb_url || item.image_url);
      const fetched = await Promise.all(urls.map(fetchThumbBase64));
      return fetched.filter(Boolean);
    })
  );

  // Track image outcomes (thumb-only now; full-res counter stays for the report)
  if (tracker) {
    for (const photos of imageData) {
      if (photos.length === 0) tracker.imagesFailed++;
      tracker.imagesThumb += photos.length;
    }
  }

  // STEP 1 — classify only (no prices)
  const tags = await classifyItems(items, imageData, tracker);
  if (tracker) tracker.itemsClassified += tags.filter(Boolean).length;

  // Attach the original item title to each tag so buildSearchQuery can extract
  // dimensions as a fallback when the classifier drops them from the model field.
  for (let i = 0; i < tags.length; i++) {
    if (tags[i]) tags[i]._title = items[i]?.title || '';
  }

  // STEP 2/3 — route each item, run comp searches sequentially (rate limits).
  // Searches are gated by the daily spend budget: before each search we check
  // today's accumulated cost; once it would exceed DAILY_BUDGET_USD we stop
  // searching. Unsearched items still get a price below (cheap AI estimate), so
  // nothing is dropped — it just isn't web-verified until budget allows.
  const comps = new Array(tags.length).fill(null);
  let toSearch = tags
    .map((tag, i) => ({ tag, i }))
    .filter(({ tag }) => tag && shouldSearch(tag));

  // Search soonest-ending first so the most time-sensitive valuable lots get
  // verified before the budget runs out.
  toSearch.sort((a, b) => {
    const ea = parseInt(items[a.i]?.ends) || Infinity;
    const eb = parseInt(items[b.i]?.ends) || Infinity;
    return ea - eb;
  });

  let spentToday = await getTodaySpend();
  let searchesRun = 0, searchesSkipped = 0;
  for (const { tag, i } of toSearch) {
    // Hard stop: if this search would push today's spend over the cap, stop.
    if (spentToday + BUDGETED_SEARCH_COST > DAILY_BUDGET_USD) {
      searchesSkipped++;
      continue; // leave comps[i] null → priced by cheap AI estimate below
    }
    comps[i] = await searchComps(tag, tracker);
    spentToday += BUDGETED_SEARCH_COST;
    await addTodaySpend(BUDGETED_SEARCH_COST);
    searchesRun++;
    await new Promise(r => setTimeout(r, 4000));
  }
  if (tracker) tracker.itemsSearched += searchesRun;
  if (searchesSkipped > 0) {
    console.log(`[Scan] Daily $${DAILY_BUDGET_USD} budget reached — ran ${searchesRun} searches, deferred ${searchesSkipped} (priced via AI estimate). Spend today ~$${spentToday.toFixed(2)}.`);
  }

  // Build final results.
  // Pricing priority: (1) comps if we searched, (2) the AI's own resale estimate
  // when it was confident enough that we skipped the search, (3) crude category
  // heuristic only as a last resort for items with no estimate at all.
  const results = tags.map((tag, i) => {
    if (!tag) return null;
    const item = items[i];

    let resale = priceFromComps(comps[i], tag);
    let source = 'comps';
    if (resale === null || resale <= 0) {
      const aiEst = Number(tag.estResale) || 0;
      if (aiEst > 0) {
        // The AI tends to anchor toward new-retail rather than used-resale for
        // unverified items. Apply a modest haircut to counter that known bias.
        // (Only applies to items that skipped the search — verified comps don't
        // need this.) Items reaching here are < $80 by the shouldSearch rules.
        resale = Math.round(aiEst * 0.85);
        source = `ai-${tag.priceConfidence || 'est'}`;
        if (tracker) tracker.itemsAiPriced = (tracker.itemsAiPriced || 0) + 1;
      } else {
        resale = priceFromHeuristic(tag);
        source = 'heuristic';
        if (tracker) tracker.itemsHeuristic++;
      }
    }

    // Low-demand fixtures/window treatments: hard 90% cut — they list high but
    // almost never sell locally (BidRL cofounder guidance).
    if (isLowDemand(tag)) {
      resale = Math.round(resale * LOW_DEMAND_MULT);
      source = `${source}+low-demand`;
    }

    // Partial/multi-box lots ("1 of 2 boxes", "box 2 of 3") aren't a complete,
    // resellable item — zero the resale so they aren't shown or fire-flagged as a
    // deal (getItems filters resell_value > 0). Overrides whatever was computed.
    if (isPartialLot(item.title)) {
      resale = 0;
      source = 'partial-lot';
    }

    const label = [tag.brand, tag.model].filter(Boolean).join(' ') || tag.subtype || tag.category || item.title.slice(0, 50);
    const compThin = comps[i] && ((comps[i].count || 0) <= 1 || comps[i].confidence === 'low');
    const compNote = comps[i]
      ? `${comps[i].isGeneric ? 'generic-comp' : 'branded-comp'} median $${comps[i].median} (${comps[i].count} pts${compThin ? ', thin' : ''})`
      : (source.startsWith('ai') ? 'AI price (no search needed)' : 'no comps');

    return {
      lotId: item.lot_number,
      lotTitle: label,
      totalEstimatedValue: resale > 0 ? Math.round(resale) : 0,
      condition: tag.condition || 'unknown',
      lotNotes: `${label} | ${tag.category}/${tag.sizeClass} | ${compNote} | ${source} = $${Math.round(resale)}`,
    };
  }).filter(Boolean);

  return results;
}

// Main scan function for one affiliate
// Concurrency guard — prevents two overlapping scans of the same affiliate
// (e.g. if a cron fires while a previous slow scan is still running, or two
// processes briefly coexist during a deploy). Without this, overlapping scans
// double the work and can re-analyze the same items.
const scansInProgress = new Set();

async function scanAffiliate(affiliateId, maxItems = null) {
  const affKey = String(affiliateId);
  if (scansInProgress.has(affKey)) {
    console.log(`[Scan] Affiliate ${affKey} scan already in progress — skipping this run`);
    return;
  }
  scansInProgress.add(affKey);
  console.log(`[Scan] Starting affiliate ${affiliateId}${maxItems ? ` (limited to ${maxItems} new items)` : ''}`);

  try {
  // Only delete lots that ended MORE THAN 7 DAYS AGO. Keeping recently-ended
  // lots means an item that disappears and reappears across auctions stays in
  // the DB and is NOT re-analyzed (and not re-billed). Expired lots are already
  // hidden from users by the ends_at filter on read queries, so keeping them
  // costs nothing but storage while preventing expensive re-analysis churn.
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - (7 * 86400);

  // ARCHIVE before delete: the last current_bid on an ended lot IS the hammer
  // price (Pusher keeps bids live through close). sold_lots is the durable
  // record of what things actually go for — our own comp database, and the
  // ground truth for grading resale estimates. final_bid 0 = went unsold.
  const { data: endedRows } = await supabase
    .from('analyzed_lots')
    .select('*')
    .eq('affiliate_id', String(affiliateId))
    .lt('ends_at', sevenDaysAgo);
  if (endedRows?.length) {
    const archive = endedRows.map(r => ({
      lot_number: r.lot_number,
      affiliate_id: r.affiliate_id,
      title: r.title,
      condition: r.condition,
      resell_value: r.resell_value,
      final_bid: parseFloat(r.current_bid) || 0,
      high_bidder: r.high_bidder,
      ends_at: r.ends_at,
      auction_id: r.auction_id,
      auction_title: r.auction_title,
      item_url: r.item_url,
      image_url: r.image_url,
      lot_notes: r.lot_notes,
      analyzed_at: r.analyzed_at,
    }));
    const { error: archErr } = await supabase
      .from('sold_lots')
      .upsert(archive, { onConflict: 'lot_number,affiliate_id', ignoreDuplicates: true });
    if (archErr) console.error('[Scan] sold_lots archive error (rows still deleted):', archErr.message);
    else console.log(`[Scan] Archived ${archive.length} ended lots to sold_lots`);
  }

  const { error: cleanupError } = await supabase
    .from('analyzed_lots')
    .delete()
    .eq('affiliate_id', String(affiliateId))
    .lt('ends_at', sevenDaysAgo);
  if (!cleanupError) console.log(`[Scan] Cleaned up lots ended >7 days ago`);

  const { data: scanLog } = await supabase
    .from('scan_log')
    .insert({ affiliate_id: affiliateId, status: 'running' })
    .select().single();

  try {
    const allItems = await fetchAllItems(affiliateId);
    console.log(`[Scan] Fetched ${allItems.length} unique items`);

    // Get already-analyzed lot numbers from DB — analyze each lot only once
    const { data: existing } = await supabase
      .from('analyzed_lots')
      .select('lot_number, current_bid, ends_at')
      .eq('affiliate_id', String(affiliateId));

    const existingMap = new Map((existing || []).map(r => [r.lot_number, r]));

    // Split into new items (need full analysis) and existing (just update bid)
    let newItems = allItems.filter(i => !existingMap.has(i.lot_number));
    const existingItems = allItems.filter(i => existingMap.has(i.lot_number));

    // Cap how many new items get analyzed in one run (throttle cost / drain
    // backlog gradually). Prioritize soonest-ending lots so the most
    // time-sensitive auctions get analyzed first; the rest stay "new" and are
    // picked up on subsequent scans.
    if (maxItems && newItems.length > maxItems) {
      newItems.sort((a, b) => {
        const ea = parseInt(a.ends) || Infinity;
        const eb = parseInt(b.ends) || Infinity;
        return ea - eb; // soonest-ending first
      });
      console.log(`[Scan] Capping ${newItems.length} new items to ${maxItems} (soonest-ending first; rest deferred to next scan)`);
      newItems = newItems.slice(0, maxItems);
    }

    console.log(`[Scan] ${newItems.length} new items to analyze, ${existingItems.length} existing (bid refresh only)`);

    // Update bids for existing items — only update bid columns, don't insert.
    // IMPORTANT: a scan's fetched bid is a snapshot from the START of the scan
    // and may be STALE relative to a fresher value Pusher already wrote. BidRL
    // bids only ever increase, so we guard each update to only RAISE the bid
    // (current_bid < new). This prevents a slow scan from clobbering a newer
    // Pusher bid with an older, lower one. ends_at/item_id are safe to refresh
    // unconditionally and are handled in a separate update.
    if (existingItems.length > 0) {
      for (const item of existingItems) {
        const newBid = parseFloat(item.current_bid) || 0;
        const newMin = parseFloat(item.minimum_bid) || 0;
        const endsAt = trueEndsAt(item);

        // 1) Raise the bid only if our fetched value is higher than what's stored
        //    (Pusher may have written a fresher/higher value already).
        if (newBid > 0) {
          await supabase
            .from('analyzed_lots')
            .update({ current_bid: newBid, minimum_bid: newMin })
            .eq('lot_number', item.lot_number)
            .eq('affiliate_id', String(affiliateId))
            .lt('current_bid', newBid); // only if stored bid is LOWER → never lower a bid
        }

        // 2) Always refresh non-bid metadata (end time, item id, high bidder).
        //    high_bidder (BidRL "winner") changes as bidding happens, so refresh
        //    it unconditionally like ends_at — not gated by the bid-raise guard.
        await supabase
          .from('analyzed_lots')
          .update({ ends_at: endsAt, item_id: item.id || null, high_bidder: item.winner || item.highbidder_username || null })
          .eq('lot_number', item.lot_number)
          .eq('affiliate_id', String(affiliateId));
      }
      console.log(`[Scan] Updated bids for ${existingItems.length} existing items`);
    }

    // Full vision + web search analysis for new items only
    const BATCH_SIZE = 10;
    let totalAnalyzed = 0;
    const tracker = makeCostTracker();

    for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
      const batch = newItems.slice(i, i + BATCH_SIZE);
      console.log(`[Scan] Analyzing batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(newItems.length/BATCH_SIZE)}`);

      try {
        const results = await analyzeBatchWithVision(batch, tracker);

        const upsertRows = [];
        for (const [j, item] of batch.entries()) {
          const result = results[j] || {};
          let resellValue = result.totalEstimatedValue;
          if (typeof resellValue === 'string') resellValue = parseFloat(resellValue.replace(/[$,]/g, '')) || 0;

          // Record EVERY analyzed lot — even zero-value ones — so they are never
          // re-analyzed on subsequent scans. Zero-value lots are stored but filtered
          // out of user-facing results by the resell_value > 0 query condition.
          upsertRows.push({
            lot_number: item.lot_number,
            affiliate_id: String(affiliateId),
            auction_id: item.auction_id,
            auction_title: item.auction_title,
            title: item.title,
            image_url: item.thumb_url || null,
            item_url: item.item_url,
            item_id: item.id || null,
            current_bid: parseFloat(item.current_bid) || 0,
            minimum_bid: parseFloat(item.minimum_bid) || 0,
            ends_at: trueEndsAt(item),
            high_bidder: item.winner || item.highbidder_username || null,
            resell_value: Math.round(resellValue) || 0,
            condition: result.condition || 'unknown',
            lot_notes: result.lotNotes || null,
            analyzed_at: new Date().toISOString(),
          });
          if (resellValue > 0) totalAnalyzed++;
        }

        if (upsertRows.length > 0) {
          await supabase.from('analyzed_lots')
            .upsert(upsertRows, { onConflict: 'lot_number,affiliate_id' });
        }
      } catch(e) {
        console.error(`[Scan] Batch error:`, e.message);
        if (/credit balance|usage limit|specified API usage/i.test(e.message || '')) {
          console.error('[Scan] ⛔ Anthropic quota/credits exhausted — aborting remaining batches. Top up credits or raise the usage limit.');
          break;
        }
      }

      if (i + BATCH_SIZE < newItems.length) await new Promise(r => setTimeout(r, 3000));
    }

    await supabase.from('scan_log').update({
      items_scanned: allItems.length,
      items_analyzed: totalAnalyzed,
      completed_at: new Date().toISOString(),
      status: 'completed',
    }).eq('id', scanLog.id);

    console.log(`[Scan] Done: ${totalAnalyzed} new, ${existingItems.length} bid-refreshed`);
    if (newItems.length > 0) printCostReport(tracker, affiliateId, newItems.length);
  } catch(e) {
    console.error(`[Scan] Failed:`, e.message);
    if (scanLog?.id) await supabase.from('scan_log').update({ status: 'failed' }).eq('id', scanLog.id);
  }

  } finally {
    // Always release the scan lock, even on error
    scansInProgress.delete(affKey);
  }
}


// Lightweight bid refresh — no AI, just update current bids in DB
export async function refreshBidsForAffiliate(affiliateId) {
  console.log(`[Refresh] Updating bids for affiliate ${affiliateId}`);
  try {
    const allItems = await fetchAllItems(affiliateId);

    // Update bid for each item — only RAISE the bid, never lower it, so a stale
    // fetch can't clobber a fresher Pusher value (BidRL bids only increase).
    for (const item of allItems) {
      const newBid = parseFloat(item.current_bid) || 0;
      const endsAt = trueEndsAt(item);

      if (newBid > 0) {
        await supabase
          .from('analyzed_lots')
          .update({ current_bid: newBid })
          .eq('lot_number', item.lot_number)
          .eq('affiliate_id', String(affiliateId))
          .lt('current_bid', newBid);
      }
      // end time + high bidder are safe to refresh unconditionally (both change
      // as bidding happens, independent of whether the bid value raised here)
      await supabase
        .from('analyzed_lots')
        .update({ ends_at: endsAt, high_bidder: item.winner || item.highbidder_username || null })
        .eq('lot_number', item.lot_number)
        .eq('affiliate_id', String(affiliateId));
    }

    console.log(`[Refresh] Updated ${allItems.length} bids for affiliate ${affiliateId}`);
  } catch(e) {
    console.error(`[Refresh] Error:`, e.message);
  }
}

// Scan a single affiliate (called by cron)
export async function runScanForAffiliate(affiliateId, maxItems = null) {
  await scanAffiliate(affiliateId, maxItems);
}

// Scan all affiliates (manual trigger)
export async function runFullScan(req, res) {
  // Don't block the response
  res?.json({ ok: true, message: 'Scan started' });

  try {
    const affRes = await fetch('https://www.bidrl.com/api/affiliateslist', {
      method: 'POST', headers: BIDRL_HEADERS,
    });
    const affiliates = await affRes.json();
    const activeAffiliates = affiliates.filter(a => a.value && a.value !== '0');

    console.log(`[Scan] Starting full scan of ${activeAffiliates.length} affiliates`);

    // Scan affiliates sequentially to avoid hammering BidRL
    for (const aff of activeAffiliates) {
      await scanAffiliate(aff.value);
    }

    console.log('[Scan] Full scan complete');
  } catch(e) {
    console.error('[Scan] Full scan error:', e.message);
  }
}

// POST /api/request-location — track user requests for new locations
export async function requestLocation(req, res) {
  const { affiliateId, affiliateName, sessionToken } = req.body;
  if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });

  try {
    // Resolve user from Bearer token or sessionToken in body
    const token = req.headers.authorization?.replace('Bearer ', '') || sessionToken;
    let userId = null;
    if (token) {
      try {
        const { validateSession } = await import('./auth.js');
        const user = await validateSession(token);
        userId = user?.id ?? null;
      } catch(e) {}
    }

    await supabase.from('location_requests').insert({
      affiliate_id: String(affiliateId),
      affiliate_name: affiliateName || null,
      user_id: userId,
    });

    const { count } = await supabase
      .from('location_requests')
      .select('*', { count: 'exact' })
      .eq('affiliate_id', String(affiliateId));

    res.json({ ok: true, totalRequests: count });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/location-requests — admin view of demand by location
export async function getLocationRequests(req, res) {
  try {
    const { data } = await supabase
      .from('location_requests')
      .select('affiliate_id, affiliate_name')
      .order('requested_at', { ascending: false });

    const counts = {};
    (data || []).forEach(r => {
      const key = r.affiliate_id;
      if (!counts[key]) counts[key] = { affiliateId: key, name: r.affiliate_name, requests: 0 };
      counts[key].requests++;
    });

    res.json({ locations: Object.values(counts).sort((a, b) => b.requests - a.requests) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/reveal/:lotNumber — usage-gated lot lookup for free users
export async function revealLot(req, res) {
  const { lotNumber } = req.params;
  const { personalBypass } = req.query;
  const isPersonalBypass = !!process.env.PERSONAL_BYPASS_TOKEN && personalBypass === process.env.PERSONAL_BYPASS_TOKEN;

  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.sessionToken;
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;

    let userId = null;
    let isPro = false;

    if (token) {
      const { validateSession } = await import('./auth.js');
      const user = await validateSession(token);
      if (user) {
        userId = user.id;
        isPro = user.is_pro || false;
      }
    }

    // Check and increment usage for non-Pro users
    if (!isPersonalBypass && !isPro) {
      const { checkAndIncrementUsage } = await import('./auth.js');
      const usage = await checkAndIncrementUsage(deviceId, userId);
      if (!usage.allowed) {
        return res.status(402).json({
          error: 'Daily limit reached',
          code: 'LIMIT_REACHED',
          used: usage.used,
          limit: usage.limit,
        });
      }
      res.setHeader('X-Usage-Used', usage.used);
      res.setHeader('X-Usage-Limit', usage.limit);
    }

    // Return lot data
    const { data, error } = await supabase
      .from('analyzed_lots')
      .select('*')
      .eq('lot_number', lotNumber)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Not found' });

    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/lot/:lotNumber — get single lot analysis from DB (no usage gate)
// NOTE: returns the (paid) resell_value un-gated. Gating is HELD because the live
// BidRL extension reads this endpoint; gating it would rate-limit free extension
// users (esp. if they send no x-device-id). Re-do once the extension passes a
// device id / Pro session — see memory: server-security-review (#2).
export async function getLotAnalysis(req, res) {
  const { lotNumber } = req.params;
  try {
    const { data, error } = await supabase
      .from('analyzed_lots')
      .select('*')
      .eq('lot_number', lotNumber)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/items?affiliateId=75&page=1&limit=24 — paginated analyzed items
export async function getItems(req, res) {
  const { affiliateId, page = 1, limit = 24, sort = 'ending', all = 'false' } = req.query;
  if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });

  try {
    const now = Math.floor(Date.now() / 1000);
    const orderCol = sort === 'resell' ? 'resell_value' : 'ends_at';
    const ascending = sort !== 'resell';
    const fetchAll = all === 'true';

    // Check if user is Pro
    let isPro = false;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.sessionToken;
      if (token) {
        const { validateSession } = await import('./auth.js');
        const user = await validateSession(token);
        isPro = user?.is_pro || false;
      }
    } catch(e) {}

    let query = supabase
      .from('analyzed_lots')
      .select('*', { count: 'exact' })
      .eq('affiliate_id', String(affiliateId))
      .gt('ends_at', now)
      .gt('resell_value', 0)
      .order(orderCol, { ascending });

    if (fetchAll) {
      // Return all active lots in one request
      query = query.limit(2000);
    } else {
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(50, parseInt(limit));
      const offset = (pageNum - 1) * limitNum;
      query = query.range(offset, offset + limitNum - 1);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const items = (data || []).map(item => ({
      ...item,
      resell_value: isPro ? item.resell_value : null,
      lot_notes: isPro ? item.lot_notes : null,
    }));

    const responsePage = fetchAll ? 1 : Math.max(1, parseInt(page));
    const responseLimit = fetchAll ? items.length : Math.min(50, parseInt(limit));

    return res.json({
      items,
      page: responsePage,
      limit: responseLimit,
      total: count || 0,
      total_pages: fetchAll ? 1 : Math.ceil((count || 0) / responseLimit),
      isPro,
    });
  } catch(e) {
    console.error('[Items] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

export async function getTopPicks(req, res) {
  const { affiliateId } = req.query;
  if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });

  try {
    // Get items analyzed in last 24 hours, sorted by resell value
    const now = Math.floor(Date.now() / 1000);
    const { data, error } = await supabase
      .from('analyzed_lots')
      .select('*')
      .eq('affiliate_id', String(affiliateId))
      .gt('ends_at', now) // only active lots
      .gt('resell_value', 0)
      .order('resell_value', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Dedupe by title, take top 10
    const seen = new Set();
    const picks = (data || []).filter(row => {
      const key = row.title.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    return res.json({ picks, lastUpdated: picks[0]?.analyzed_at || null });
  } catch(e) {
    console.error('[TopPicks] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// GET /api/reveal/:lotNumber — usage-gated lot lookup for free users
