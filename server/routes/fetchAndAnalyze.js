// BidMax — fetchAndAnalyze route
// Fetches ALL items from BidRL's own API server-side,
// runs the full analysis pipeline (cache → AI → eBay comps → calcBid),
// returns ranked results ready for the extension to display.

import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { getCached, setCached, calcBid, getSmartFBValue } from './analyze.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHUNK_SIZE = 50; // lots per AI call

// ─────────────────────────────────────────────────────────
// POST /api/fetch-and-analyze
// Body: { affiliateId, auctionId, settings, deviceId, sessionToken }
// ─────────────────────────────────────────────────────────
export async function fetchAndAnalyze(req, res) {
  const { affiliateId, auctionId, settings, deviceId, sessionToken } = req.body;

  if (!affiliateId && !auctionId) {
    return res.status(400).json({ error: 'affiliateId or auctionId required' });
  }

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };

  try {
    // 1. Fetch all items from BidRL
    const items = await fetchAllBidRLItems({ affiliateId, auctionId });
    if (!items.length) {
      return res.json({ results: {}, ranked: [], total: 0 });
    }

    // 2. Usage check — only charge against limit for uncached items
    const uncachedItems = items.filter(item => !getCached(item.id));
    if (uncachedItems.length > 0 && (deviceId || sessionToken)) {
      try {
        const { validateSession, checkAndIncrementUsage } = await import('./auth.js');
        let userId = null;
        if (sessionToken) {
          const user = await validateSession(sessionToken);
          if (user) userId = user.id;
        }
        const usage = await checkAndIncrementUsage(deviceId, userId);
        if (!usage.allowed) {
          return res.status(402).json({
            error: 'Daily limit reached',
            code: 'LIMIT_REACHED',
            used: usage.used,
            limit: usage.limit,
          });
        }
        if (!usage.isPro) {
          res.setHeader('X-Usage-Used', usage.used);
          res.setHeader('X-Usage-Limit', usage.limit);
        }
      } catch (err) {
        console.error('Usage check error:', err.message);
        // Don't block on usage check failure
      }
    }

    // 3. Split cached vs needs analysis
    const results = {};
    const toAnalyze = [];

    for (const item of items) {
      const cached = getCached(item.id);
      if (cached) {
        results[item.id] = { ...cached, cached: true };
      } else {
        toAnalyze.push(item);
      }
    }

    // 4. Analyze uncached items in chunks
    for (let i = 0; i < toAnalyze.length; i += CHUNK_SIZE) {
      const chunk = toAnalyze.slice(i, i + CHUNK_SIZE);
      const chunkResults = await analyzeChunk(chunk, s);
      Object.assign(results, chunkResults);
    }

    // 5. Rank by estimated profit descending
    const ranked = items
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
        images: item.images || [],
        category: item.category_name || '',
        buyerPremium: parseFloat(item.buyer_premium) || 13,
        result: results[item.id] || null,
      }))
      .filter(r => r.result && r.result.breakdown?.expectedProfit >= 10 && r.result.breakdown?.maxBid > 0)
      .sort((a, b) => b.result.breakdown.expectedProfit - a.result.breakdown.expectedProfit)
      .slice(0, 50); // cap at top 50

    res.json({
      results,
      ranked,
      total: items.length,
      analyzed: toAnalyze.length,
      cached: items.length - toAnalyze.length,
    });

  } catch (err) {
    console.error('fetchAndAnalyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
