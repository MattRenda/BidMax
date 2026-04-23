// BidMax — fetchAndAnalyze route
// Fetches ALL items from BidRL's own API server-side,
// runs the full analysis pipeline (cache → AI → eBay comps → calcBid),
// returns ranked results ready for the extension to display.

import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { getCached, setCached, calcBid, getSmartFBValue } from './analyze.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHUNK_SIZE = 50;

// Whole-auction result cache — keyed by affiliateId/auctionId
// So second+ requests return instantly without re-fetching or re-analyzing
const auctionCache = new Map();
const AUCTION_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────
// POST /api/fetch-and-analyze
// ─────────────────────────────────────────────────────────
export async function fetchAndAnalyze(req, res) {
  const { affiliateId, auctionId, settings, deviceId, sessionToken } = req.body;

  if (!affiliateId && !auctionId) {
    return res.status(400).json({ error: 'affiliateId or auctionId required' });
  }

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };
  const cacheKey = `auction_${affiliateId || auctionId}`;

  // Return full cached result instantly if fresh
  const auctionCached = auctionCache.get(cacheKey);
  if (auctionCached && Date.now() - auctionCached.ts < AUCTION_CACHE_TTL) {
    console.log(`[fetchAndAnalyze] Cache hit for ${cacheKey}`);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ type: 'chunk', results: auctionCached.data.results, ranked: auctionCached.data.ranked }) + '\n');
    res.write(JSON.stringify({ type: 'done', total: auctionCached.data.total, fromCache: true }) + '\n');
    return res.end();
  }

  // Stream results back as NDJSON chunks
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    // 1. Fetch all items from BidRL
    const items = await fetchAllBidRLItems({ affiliateId, auctionId });
    if (!items.length) {
      res.write(JSON.stringify({ type: 'done', total: 0 }) + '\n');
      return res.end();
    }

    // 2. Usage check
    if (deviceId || sessionToken) {
      try {
        const { validateSession, checkAndIncrementUsage } = await import('./auth.js');
        let userId = null;
        if (sessionToken) {
          const user = await validateSession(sessionToken);
          if (user) userId = user.id;
        }
        const usage = await checkAndIncrementUsage(deviceId, userId);
        if (!usage.allowed) {
          res.write(JSON.stringify({ type: 'error', code: 'LIMIT_REACHED', used: usage.used, limit: usage.limit }) + '\n');
          return res.end();
        }
      } catch (err) {
        console.error('Usage check error:', err.message);
      }
    }

    // 3. Split cached vs needs analysis
    const allResults = {};
    const toAnalyze = [];

    for (const item of items) {
      const cached = getCached(item.id);
      if (cached) {
        allResults[item.id] = { ...cached, cached: true };
      } else {
        toAnalyze.push(item);
      }
    }

    // Send cached results immediately as first chunk
    if (Object.keys(allResults).length > 0) {
      const cachedRanked = buildRanked(items, allResults);
      res.write(JSON.stringify({ type: 'chunk', results: allResults, ranked: cachedRanked }) + '\n');
    }

    // 4. Analyze uncached items chunk by chunk, streaming each result
    for (let i = 0; i < toAnalyze.length; i += CHUNK_SIZE) {
      const chunk = toAnalyze.slice(i, i + CHUNK_SIZE);
      const chunkResults = await analyzeChunk(chunk, s);
      Object.assign(allResults, chunkResults);

      // Stream this chunk's results immediately
      const chunkRanked = buildRanked(items, allResults);
      res.write(JSON.stringify({ type: 'chunk', results: chunkResults, ranked: chunkRanked }) + '\n');
    }

    // 5. Final done signal
    const finalRanked = buildRanked(items, allResults);
    const responseData = { results: allResults, ranked: finalRanked, total: items.length };
    auctionCache.set(cacheKey, { data: responseData, ts: Date.now() });

    res.write(JSON.stringify({ type: 'done', total: items.length, analyzed: toAnalyze.length }) + '\n');
    res.end();

  } catch (err) {
    console.error('fetchAndAnalyze error:', err.message);
    res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
    res.end();
  }
}

function buildRanked(items, results) {
  return items
    .map(item => ({
      id: item.id,
      lotNumber: item.lot_number,
      title: item.title,
      currentBid: parseFloat(item.current_bid) || 0,
      minimumBid: parseFloat(item.minimum_bid) || 0,
      bidCount: parseInt(item.bid_count) || 0,
      endsAt: item.end_time,
      itemUrl: item.item_url,
      thumbUrl: item.thumb_url,
      category: item.category_name || '',
      buyerPremium: parseFloat(item.buyer_premium) || 13,
      result: results[item.id] || null,
    }))
    .filter(r => r.result && r.result.breakdown?.expectedProfit >= 5 && r.result.breakdown?.maxBid > 0)
    .sort((a, b) => b.result.breakdown.expectedProfit - a.result.breakdown.expectedProfit)
    .slice(0, 50);
}

// ─────────────────────────────────────────────────────────
// Fetch all items from BidRL, paginating through all pages
// ─────────────────────────────────────────────────────────
async function fetchAllBidRLItems({ affiliateId, auctionId }) {
  const PER_PAGE = 200;
  let page = 1;
  let totalPages = 1;
  const allItems = [];

  do {
    const body = new URLSearchParams();
    if (affiliateId) body.set('filters[affiliates]', affiliateId);
    if (auctionId) body.set('filters[auction_id]', auctionId);
    body.set('filters[sortlist]', 'end_time ASC');
    body.set('page', String(page));
    body.set('perpage', String(PER_PAGE));

    const res = await fetch('https://www.bidrl.com/api/getItems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`BidRL API error: ${res.status}`);
    const data = await res.json();

    allItems.push(...(data.items || []));
    totalPages = data.total_pages || 1;
    page++;
  } while (page <= totalPages);

  return allItems;
}

// ─────────────────────────────────────────────────────────
// Analyze a chunk of BidRL item objects
// ─────────────────────────────────────────────────────────
async function analyzeChunk(items, s) {
  const lotsText = items.map((item, i) => {
    const parts = [
      `LOT_${i}: [${item.id}] ${item.title}`,
      item.description ? `— ${item.description.slice(0, 100)}` : '',
      `| Category: ${item.category_name || 'unknown'}`,
      `| Current bid: $${item.current_bid}`,
      `| Buyer premium: ${item.buyer_premium}%`,
    ];
    return parts.filter(Boolean).join(' ');
  }).join('\n');

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: Math.min(120 * items.length + 200, 4096),
    messages: [{
      role: 'user',
      content: `Expert reseller. Estimate realistic LOCAL Facebook Marketplace resale value for each auction lot. Return ONLY a JSON array, no markdown.

${lotsText}

Rules:
- Factory sealed / new in box = 60-70% of retail price
- If retail price is mentioned in title, anchor to it strongly
- Used condition = 30-50% of retail
- Be realistic — local FB buyers pay fair prices for good items
- If item is not resellable or unclear, set totalEstimatedValue to 0

JSON array, one object per lot, same order:
[{"lotId":"id","lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"brief insight"}]`,
    }],
  });

  let rawText = message.content[0].text.replace(/```json|```/g, '').trim();
  let parsed = [];
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const lastBrace = rawText.lastIndexOf('}');
    if (lastBrace > 0) {
      try { parsed = JSON.parse(rawText.slice(0, lastBrace + 1) + ']'); } catch { parsed = []; }
    }
  }

  // Enhance with eBay comps in parallel, then calcBid
  const results = {};
  const enhanced = await Promise.all(items.map(async (item, i) => {
    const data = parsed[i] || {};
    const aiEstimate = data.totalEstimatedValue || 0;
    const { fbValue, source, ebayPrice, retailPrice } = await getSmartFBValue(item.title || '', aiEstimate);

    // Use buyer_premium from the actual item data
    const itemSettings = {
      ...s,
      buyersPremium: parseFloat(item.buyer_premium) || s.buyersPremium,
    };

    const result = {
      ...data,
      lotId: item.id,
      lotNumber: item.lot_number,
      itemTitle: item.title,
      itemUrl: item.item_url,
      thumbUrl: item.thumb_url,
      images: (item.images || []).slice(0, 1), // first image only to save space
      currentBid: parseFloat(item.current_bid) || 0,
      minimumBid: parseFloat(item.minimum_bid) || 0,
      bidCount: parseInt(item.bid_count) || 0,
      buyerPremium: parseFloat(item.buyer_premium) || 13,
      totalEstimatedValue: fbValue,
      valueSource: source,
      ...(ebayPrice && { ebayAvgPrice: ebayPrice }),
      ...(retailPrice && { retailPrice }),
      breakdown: calcBid(fbValue, itemSettings),
    };

    return { id: item.id, result };
  }));

  for (const { id, result } of enhanced) {
    setCached(id, result);
    results[id] = result;
  }

  return results;
}
