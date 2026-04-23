import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { getCached, setCached, calcBid, getSmartFBValue } from './analyze.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CHUNK_SIZE = 50;
const auctionCache = new Map();
const AUCTION_CACHE_TTL = 60 * 60 * 1000;

export async function fetchAndAnalyze(req, res) {
  const { affiliateId, auctionId, settings, deviceId, sessionToken } = req.body;
  if (!affiliateId && !auctionId) return res.status(400).json({ error: 'affiliateId or auctionId required' });

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 0, effortCost: 0, ...settings };
  const cacheKey = `auction_v3_${affiliateId || auctionId}`;

  // Return cached result instantly
  const cached = auctionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AUCTION_CACHE_TTL) {
    console.log(`[fetchAndAnalyze] Cache hit ${cacheKey}`);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ type: 'chunk', items: cached.items }) + '\n');
    res.write(JSON.stringify({ type: 'done', total: cached.items.length, fromCache: true }) + '\n');
    return res.end();
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    // 1. Fetch ALL items from BidRL
    const bidrlItems = await fetchAllBidRLItems({ affiliateId, auctionId });
    if (!bidrlItems.length) {
      res.write(JSON.stringify({ type: 'done', total: 0 }) + '\n');
      return res.end();
    }

    // 2. Split cached vs uncached
    const allAnalyzed = [];
    const toAnalyze = [];

    for (const item of bidrlItems) {
      const analysis = getCached(item.id);
      if (analysis && analysis.totalEstimatedValue > 0) {
        // Merge BidRL item + cached analysis into one complete object
        allAnalyzed.push(mergeItem(item, analysis));
      } else {
        toAnalyze.push(item);
      }
    }

    // Send cached items immediately
    if (allAnalyzed.length > 0) {
      res.write(JSON.stringify({ type: 'chunk', items: allAnalyzed }) + '\n');
    }

    // 3. Analyze uncached in chunks
    for (let i = 0; i < toAnalyze.length; i += CHUNK_SIZE) {
      const chunk = toAnalyze.slice(i, i + CHUNK_SIZE);
      const analyzed = await analyzeChunk(chunk, s);
      allAnalyzed.push(...analyzed);
      res.write(JSON.stringify({ type: 'chunk', items: analyzed }) + '\n');
    }

    // Cache full result
    auctionCache.set(cacheKey, { items: allAnalyzed, ts: Date.now() });
    res.write(JSON.stringify({ type: 'done', total: allAnalyzed.length }) + '\n');
    res.end();

  } catch (err) {
    console.error('fetchAndAnalyze error:', err.message);
    res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
    res.end();
  }
}

// Merge the BidRL item (has images, URLs etc) with the analysis result
function mergeItem(bidrlItem, analysis) {
  return {
    // BidRL item fields — the ground truth for display
    id: bidrlItem.id,
    lotNumber: bidrlItem.lot_number,
    title: bidrlItem.title,
    itemUrl: bidrlItem.item_url,
    thumbUrl: bidrlItem.thumb_url || bidrlItem.images?.[0]?.thumb_url || '',
    images: bidrlItem.images || [],
    currentBid: parseFloat(bidrlItem.current_bid) || 0,
    minimumBid: parseFloat(bidrlItem.minimum_bid) || 0,
    bidCount: parseInt(bidrlItem.bid_count) || 0,
    buyerPremium: parseFloat(bidrlItem.buyer_premium) || 13,
    endTime: bidrlItem.end_time,
    category: bidrlItem.category_name || '',
    // Analysis result
    totalEstimatedValue: analysis.totalEstimatedValue || 0,
    valueSource: analysis.valueSource || '',
    breakdown: analysis.breakdown || null,
    lotNotes: analysis.lotNotes || analysis.lotTitle || '',
  };
}

async function fetchAllBidRLItems({ affiliateId, auctionId }) {
  const PER_PAGE = 200;
  let page = 1, totalPages = 1;
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
        'User-Agent': 'Mozilla/5.0',
      },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`BidRL API error: ${res.status}`);
    const data = await res.json();
    allItems.push(...(data.items || []));
    totalPages = data.total_pages || 1;
    page++;
  } while (page <= totalPages);

  console.log(`[fetchAndAnalyze] Fetched ${allItems.length} items from BidRL`);
  return allItems;
}

async function analyzeChunk(items, s) {
  const lotsText = items.map((item, i) =>
    `LOT_${i}: [${item.id}] ${item.title} | Category: ${item.category_name || 'unknown'} | Current bid: $${item.current_bid} | Buyer premium: ${item.buyer_premium}%`
  ).join('\n');

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
- Be realistic — local FB buyers pay fair prices

JSON array, one object per lot, same order:
[{"lotId":"id","lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"brief insight"}]`,
    }],
  });

  let parsed = [];
  try {
    parsed = JSON.parse(message.content[0].text.replace(/```json|```/g, '').trim());
  } catch {
    const lastBrace = message.content[0].text.lastIndexOf('}');
    if (lastBrace > 0) {
      try { parsed = JSON.parse(message.content[0].text.slice(0, lastBrace + 1) + ']'); } catch { parsed = []; }
    }
  }

  const results = await Promise.all(items.map(async (item, i) => {
    const data = parsed[i] || {};
    const aiEstimate = data.totalEstimatedValue || 0;
    const { fbValue, source, ebayPrice, retailPrice } = await getSmartFBValue(item.title || '', aiEstimate);
    const itemSettings = { ...s, buyersPremium: parseFloat(item.buyer_premium) || s.buyersPremium };
    const analysis = {
      totalEstimatedValue: fbValue,
      valueSource: source,
      lotNotes: data.lotNotes || '',
      ...(ebayPrice && { ebayAvgPrice: ebayPrice }),
      ...(retailPrice && { retailPrice }),
      breakdown: calcBid(fbValue, itemSettings),
    };
    setCached(item.id, analysis);
    return mergeItem(item, analysis);
  }));

  return results;
}
