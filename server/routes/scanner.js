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
  'claude-haiku-4-5':           { in: 0.80 / 1e6, out: 4.00 / 1e6 },
  'claude-haiku-4-5-20251001':  { in: 0.80 / 1e6, out: 4.00 / 1e6 },
};
const WEB_SEARCH_TOOL_COST = 0.01; // approx per-search tool fee

function makeCostTracker() {
  return {
    classifyCalls: 0, classifyInTok: 0, classifyOutTok: 0,
    searchCalls: 0, searchInTok: 0, searchOutTok: 0, searchCacheHits: 0,
    imagesFullRes: 0, imagesThumb: 0, imagesFailed: 0,
    itemsClassified: 0, itemsSearched: 0, itemsHeuristic: 0,
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
    tracker.searchInTok += inTok;
    tracker.searchOutTok += outTok;
  }
}

function estCost(tracker) {
  const c = PRICING['claude-haiku-4-5'];
  const classify = tracker.classifyInTok * c.in + tracker.classifyOutTok * c.out;
  const searchTok = tracker.searchInTok * c.in + tracker.searchOutTok * c.out;
  const searchTool = tracker.searchCalls * WEB_SEARCH_TOOL_COST;
  return {
    classify,
    search: searchTok + searchTool,
    searchTokens: searchTok,
    searchTool,
    total: classify + searchTok + searchTool,
  };
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
║   calls:             ${tracker.searchCalls}
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
    .map(i => [i.lot_number, i])
  ).values()];
}

// Convert a BidRL thumbnail URL to full resolution
// Thumbnails end in _t.jpg; full-size drops the _t suffix
function toFullResUrl(url) {
  if (!url) return null;
  // e.g. .../wIMG_20260610_090559842_HDR_t.jpg -> .../wIMG_20260610_090559842_HDR.jpg
  return url.replace(/_t(\.[a-zA-Z]+)(\?.*)?$/, '$1$2');
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
async function classifyItems(items, imageData, tracker) {
  const lotsText = items.map(item => {
    const cleanTitle = item.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    const auctionHint = item.auction_title ? ` [Auction: ${item.auction_title.slice(0, 60)}]` : '';
    return `${item.lot_number}: ${cleanTitle}${auctionHint}`;
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

CONDITION RULES (priority order):
1. Title keywords first: NEW/SEALED/NIB → new; OPEN BOX/OPENED → open_box; USED/AS-IS/DAMAGED/PARTS → used_fair; GENTLY USED/REFURBISHED → used_good
2. Auction title patterns: "returns"/"dot com"/"overstock" → likely new; "undeliverable"/"variety" → likely open_box; "liquidation"/"salvage"/"estate" → likely used
3. Image only if title and auction give no signal

CATEGORY: pick the single best fit from:
electronics, appliance_large, appliance_small, furniture, tools, sporting_goods, gym_equipment, outdoor, toys, kitchenware, home_goods, apparel, health_beauty, automotive, media, collectible, bulk_lot, other

${lotsText}

Return ONLY a JSON array, one entry per lot, same order. NO prices:
[{"lotId":"RD1234","category":"outdoor","subtype":"rectangular frame pool","brand":"Intex","model":"14ft x 8ft x 3ft","sizeClass":"large","keywords":["pool","frame","14ft"],"condition":"new","idConfidence":"high"}]

idConfidence: high = brand+model clearly identified; medium = category+subtype clear, brand uncertain; low = generic/unclear.
brand/model may be null if genuinely not identifiable. sizeClass: small|medium|large.`
  }];

  items.forEach((item, i) => {
    const img = imageData[i];
    if (img) {
      contentBlocks.push({ type: 'text', text: `Image for ${item.lot_number}:` });
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
  });

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: Math.min(120 * items.length + 200, 4096),
    messages: [{ role: 'user', content: contentBlocks }],
  });
  if (tracker) logUsage(tracker, 'claude-haiku-4-5', message.usage, 'classify');

  let rawText = message.content[0].text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(rawText); }
  catch {
    const lastBrace = rawText.lastIndexOf('}');
    if (lastBrace > 0) {
      try { return JSON.parse(rawText.slice(0, lastBrace + 1) + ']'); } catch {}
    }
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// STEP 3 — COMP LOOKUP. Returns {retail, resale} from real listings.
// For branded items: search the product. For generic high-value
// items: search the category + size + "used sold price".
// ─────────────────────────────────────────────────────────────
const searchCache = new Map();

function buildSearchQuery(tag) {
  const brand = tag.brand || '';
  const model = tag.model || '';
  if (brand && model) return `${brand} ${model}`.trim();
  // Generic high-value item: build a descriptive category query
  const parts = [tag.subtype || tag.category, tag.sizeClass !== 'medium' ? tag.sizeClass : ''].filter(Boolean);
  return parts.join(' ').trim();
}

async function searchComps(tag, tracker) {
  const queryBase = buildSearchQuery(tag);
  if (!queryBase) return null;
  const key = queryBase.toLowerCase();
  if (searchCache.has(key)) {
    if (tracker) tracker.searchCacheHits++;
    return searchCache.get(key);
  }

  const isGeneric = !(tag.brand && tag.model);
  const prompt = isGeneric
    ? `Find the resale value of a ${queryBase} (condition: ${tag.condition || 'used'}). Search Facebook Marketplace, eBay sold listings, and Craigslist for what these ACTUALLY SELL FOR used. Report the typical selling price range, not new retail.`
    : `Find pricing for the ${queryBase}. Report (1) current NEW retail price on Amazon/Walmart, and (2) USED resale value from eBay sold listings or Facebook Marketplace. Give both numbers if available.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });
    if (tracker) logUsage(tracker, 'claude-haiku-4-5-20251001', resp.usage, 'search');

    const allText = resp.content
      .map(b => {
        if (b.type === 'text') return b.text;
        if (b.type === 'web_search_tool_result') {
          if (typeof b.content === 'string') return b.content;
          if (Array.isArray(b.content)) return b.content.map(c => c.text || '').join(' ');
        }
        return '';
      })
      .join(' ');

    const prices = [...allText.matchAll(/\$([0-9,]+(?:\.[0-9]{1,2})?)/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(p => p > 3 && p < 15000);

    if (prices.length === 0) { searchCache.set(key, null); return null; }

    prices.sort((a, b) => a - b);
    // Trim outliers: drop top and bottom 10% when we have enough points
    let trimmed = prices;
    if (prices.length >= 6) {
      const cut = Math.floor(prices.length * 0.1);
      trimmed = prices.slice(cut, prices.length - cut);
    }
    const mid = Math.floor(trimmed.length / 2);
    const median = trimmed.length % 2 === 0
      ? (trimmed[mid - 1] + trimmed[mid]) / 2
      : trimmed[mid];

    const result = { median: Math.round(median), isGeneric, count: prices.length };
    console.log(`[Scan] Comps "${queryBase}" → $${result.median} (${prices.length} pts: ${prices.slice(0,6).join(', ')})`);
    searchCache.set(key, result);
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
function shouldSearch(tag) {
  if (tag.idConfidence === 'low' && !(tag.brand && tag.model)) {
    // only search low-confidence if it's a known high-variance high-value category
    return ['furniture', 'gym_equipment', 'appliance_large', 'outdoor'].includes(tag.category);
  }
  // branded → always worth verifying
  if (tag.brand && tag.model) return true;
  // generic but high-value category → worth a category comp search
  if (['furniture', 'gym_equipment', 'appliance_large', 'outdoor', 'electronics'].includes(tag.category)) return true;
  // estimate a rough anchor; search if it clears $100
  const anchor = (CATEGORY_RETAIL_ANCHOR[tag.category] || 50) * (SIZE_MULT[tag.sizeClass] || 1);
  return anchor >= 100;
}

// Convert a comp result + condition into a final FB resale number.
function priceFromComps(comp, tag) {
  if (!comp || !comp.median) return null;
  // If comps were generic (already "used sold" prices), they ARE the resale value.
  // But web search can't guarantee sold-only data — some results may be retail
  // asking prices, which skew high. Apply a conservative hedge so we don't
  // overvalue (overpaying is worse for a reseller than missing a deal).
  if (comp.isGeneric) {
    return Math.round(comp.median * 0.85);
  }
  // Branded comps mix new-retail and used; convert to local FB resale by condition.
  const cond = (tag.condition || 'used_good');
  let factor;
  if (cond.includes('new')) factor = 0.62;
  else if (cond.includes('open')) factor = 0.55;
  else if (cond.includes('good')) factor = 0.48;
  else factor = 0.32; // used_fair / damaged
  return Math.round(comp.median * factor);
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
  const imageData = await Promise.all(
    items.map(item => fetchImageBase64(item.thumb_url || item.image_url))
  );

  // Track image resolution outcomes
  if (tracker) {
    for (const img of imageData) {
      if (!img) tracker.imagesFailed++;
      else if (img.res === 'full') tracker.imagesFullRes++;
      else tracker.imagesThumb++;
    }
  }

  // STEP 1 — classify only (no prices)
  const tags = await classifyItems(items, imageData, tracker);
  if (tracker) tracker.itemsClassified += tags.filter(Boolean).length;

  // STEP 2/3 — route each item, run comp searches sequentially (rate limits)
  const comps = new Array(tags.length).fill(null);
  const toSearch = tags
    .map((tag, i) => ({ tag, i }))
    .filter(({ tag }) => tag && shouldSearch(tag));

  for (const { tag, i } of toSearch) {
    comps[i] = await searchComps(tag, tracker);
    await new Promise(r => setTimeout(r, 4000));
  }
  if (tracker) tracker.itemsSearched += toSearch.length;

  // Build final results
  const results = tags.map((tag, i) => {
    if (!tag) return null;
    const item = items[i];

    let resale = priceFromComps(comps[i], tag);
    let source = 'comps';
    if (resale === null || resale <= 0) {
      resale = priceFromHeuristic(tag);
      source = 'heuristic';
      if (tracker) tracker.itemsHeuristic++;
    }

    const label = [tag.brand, tag.model].filter(Boolean).join(' ') || tag.subtype || tag.category || item.title.slice(0, 50);
    const compNote = comps[i]
      ? `${comps[i].isGeneric ? 'generic-comp' : 'branded-comp'} median $${comps[i].median} (${comps[i].count} pts)`
      : 'no comps';

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
async function scanAffiliate(affiliateId, maxItems = null) {
  console.log(`[Scan] Starting affiliate ${affiliateId}${maxItems ? ` (limited to ${maxItems} new items)` : ''}`);

  // Clean up expired lots first
  const now = Math.floor(Date.now() / 1000);
  const { error: cleanupError } = await supabase
    .from('analyzed_lots')
    .delete()
    .eq('affiliate_id', String(affiliateId))
    .lt('ends_at', now);
  if (!cleanupError) console.log(`[Scan] Cleaned up ended lots`);

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

    // Dev safety: cap how many new items get analyzed in one run
    if (maxItems && newItems.length > maxItems) {
      console.log(`[Scan] Limiting ${newItems.length} new items to ${maxItems} (dev mode)`);
      newItems = newItems.slice(0, maxItems);
    }

    console.log(`[Scan] ${newItems.length} new items to analyze, ${existingItems.length} existing (bid refresh only)`);

    // Update bids for existing items — only update bid columns, don't insert
    if (existingItems.length > 0) {
      for (const item of existingItems) {
        await supabase
          .from('analyzed_lots')
          .update({
            current_bid: parseFloat(item.current_bid) || 0,
            minimum_bid: parseFloat(item.minimum_bid) || 0,
            ends_at: item.ends ? parseInt(item.ends) + 7200 : null,
            item_id: item.id || null,
          })
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
            ends_at: item.ends ? parseInt(item.ends) + 7200 : null,
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
    await supabase.from('scan_log').update({ status: 'failed' }).eq('id', scanLog.id);
  }
}


// Lightweight bid refresh — no AI, just update current bids in DB
export async function refreshBidsForAffiliate(affiliateId) {
  console.log(`[Refresh] Updating bids for affiliate ${affiliateId}`);
  try {
    const allItems = await fetchAllItems(affiliateId);

    // Update bid for each item individually — no insert
    for (const item of allItems) {
      await supabase
        .from('analyzed_lots')
        .update({
          current_bid: parseFloat(item.current_bid) || 0,
          ends_at: item.ends ? parseInt(item.ends) + 7200 : null,
        })
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
  const isPersonalBypass = personalBypass === 'matthew-pro-bypass';

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
