import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Persistent file-backed cache ──
const CACHE_FILE = '/tmp/bidmax_cache.json';
const CACHE_TTL = 4 * 60 * 60 * 1000;

let cacheStore = {};
try {
  if (existsSync(CACHE_FILE)) cacheStore = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
} catch { cacheStore = {}; }

function saveCache() {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cacheStore)); } catch {}
}
function getCached(key) {
  const entry = cacheStore[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete cacheStore[key]; return null; }
  return entry.data;
}
function setCached(key, data) {
  const keys = Object.keys(cacheStore);
  if (keys.length > 1000) keys.sort((a, b) => cacheStore[a].ts - cacheStore[b].ts).slice(0, 200).forEach(k => delete cacheStore[k]);
  cacheStore[key] = { data, ts: Date.now() };
  saveCache();
}

function calcBid(total, { targetMargin, buyersPremium, fbFee, effortCost }) {
  const roi = targetMargin / 100;
  const premium = 1 + buyersPremium / 100;
  const fbFeeAmt = total * (fbFee / 100);
  const netSale = total - fbFeeAmt - effortCost;
  const maxBid = Math.max(0, Math.floor(netSale / premium / (1 + roi)));
  const totalCost = Math.round(maxBid * premium + effortCost + fbFeeAmt);
  const expectedProfit = Math.round(total - totalCost);
  const actualRoi = totalCost > 0 ? Math.round((expectedProfit / totalCost) * 100) : 0;
  return {
    estimatedSaleValue: total,
    fbFee: Math.round(fbFeeAmt),
    effortCost,
    buyersPremium: `${buyersPremium}%`,
    maxBid,
    expectedProfit,
    roi: actualRoi,
  };
}

// ── Fetch eBay sold comps ──
async function getEbayAvgPrice(title) {
  const appId = process.env.EBAY_APP_ID;
  if (!appId || appId === 'your_ebay_app_id_here') return null;

  try {
    // Clean title: strip auction junk, keep product name
    const cleanTitle = title
      .replace(/lot\s*#?\w+/gi, '')
      .replace(/msrp\s*\$[\d,]+/gi, '')
      .replace(/retail\s*\$[\d,]+/gi, '')
      .replace(/factory\s*sealed/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

    const query = encodeURIComponent(cleanTitle);
    const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${appId}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${query}` +
      `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
      `&itemFilter(1).name=Condition&itemFilter(1).value(0)=1000&itemFilter(1).value(1)=1500&itemFilter(1).value(2)=2000` +
      `&sortOrder=EndTimeSoonest` +
      `&paginationInput.entriesPerPage=8`;

    const response = await fetch(url);
    const data = await response.json();
    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const prices = items
      .map(item => parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0))
      .filter(p => p > 5);

    if (prices.length === 0) return null;

    // Return median to avoid outliers
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
  } catch {
    return null;
  }
}

// ── Extract retail price from title ──
function extractRetailPrice(title) {
  const match = title.match(/(?:msrp|retail|value)[:\s]*\$?([\d,]+)/i);
  return match ? parseInt(match[1].replace(/,/g, '')) : null;
}

// ── Build smart FB estimate ──
// Priority: 1) eBay sold comps, 2) retail price anchor, 3) AI estimate
async function getSmartFBValue(title, aiEstimate) {
  const [ebayPrice, retailPrice] = await Promise.all([
    getEbayAvgPrice(title),
    Promise.resolve(extractRetailPrice(title))
  ]);

  let fbValue = aiEstimate;
  let source = 'ai';

  if (ebayPrice) {
    // eBay sold price is the most reliable — FB is typically 80-90% of eBay
    fbValue = Math.round(ebayPrice * 0.85);
    source = 'ebay';
  } else if (retailPrice) {
    // Factory sealed items sell for 60-70% of retail on FB locally
    const isSealed = /factory\s*sealed|new\s*in\s*box|nib|sealed/i.test(title);
    fbValue = Math.round(retailPrice * (isSealed ? 0.65 : 0.50));
    source = 'retail';
  }

  // Never go below AI estimate — AI is our floor
  fbValue = Math.max(fbValue, aiEstimate);

  return { fbValue, source, ebayPrice, retailPrice };
}

// ── Single lot analysis ──
export async function analyzeLot(req, res) {
  const { description, lotId, settings } = req.body;
  if (!description || description.trim().length < 3) return res.status(400).json({ error: 'Please provide a lot description.' });

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };
  const cacheKey = lotId || description.slice(0, 60);
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are an expert reseller. Analyze this auction lot and return ONLY valid JSON, no markdown.

Lot: "${description}"

Return:
{"lotTitle":"short title","items":[{"name":"item","condition":"new|like new|good|fair|poor","estimatedValue":25}],"totalEstimatedValue":100,"lotNotes":"key insight"}

Rules:
- estimatedValue = realistic LOCAL Facebook Marketplace price
- Factory sealed / new in box = 60-70% of retail
- Used items = 30-50% of retail
- If retail price is in the title, anchor to it
- Be realistic, not overly conservative`
      }],
    });

    const text = message.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    // Enhance with eBay comps / retail anchoring
    const { fbValue, source, ebayPrice, retailPrice } = await getSmartFBValue(description, parsed.totalEstimatedValue || 0);
    parsed.totalEstimatedValue = fbValue;
    parsed.valueSource = source;
    if (ebayPrice) parsed.ebayAvgPrice = ebayPrice;
    if (retailPrice) parsed.retailPrice = retailPrice;

    const result = { ...parsed, breakdown: calcBid(fbValue, s) };
    setCached(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
}

// ── BATCH analysis ──
export async function analyzeBatch(req, res) {
  const { lots, settings } = req.body;
  if (!lots || !Array.isArray(lots) || lots.length === 0) return res.status(400).json({ error: 'No lots provided.' });

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };

  const results = {};
  const toAnalyze = [];

  for (const lot of lots) {
    const key = lot.lotId || lot.title?.slice(0, 60) || String(Math.random());
    const cached = getCached(key);
    if (cached) results[lot.lotId] = { ...cached, cached: true };
    else toAnalyze.push({ ...lot, _key: key });
  }

  if (toAnalyze.length === 0) return res.json({ results });

  const lotsText = toAnalyze.map((lot, i) =>
    `LOT_${i}: [${lot.lotId || 'unknown'}] ${lot.title}${lot.currentBid ? ` | Current bid: $${lot.currentBid}` : ''}${lot.minBid ? ` | Min bid: $${lot.minBid}` : ''}`
  ).join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: Math.min(120 * toAnalyze.length + 200, 4096),
      messages: [{
        role: 'user',
        content: `Expert reseller. Estimate realistic LOCAL Facebook Marketplace resale value for each lot. Return ONLY a JSON array, no markdown.

${lotsText}

Rules:
- Factory sealed / new in box = 60-70% of retail price
- If retail price is mentioned in title, anchor to it strongly
- Used condition = 30-50% of retail
- Be realistic not conservative — local FB buyers pay fair prices for good items
- "Retail $150 Factory Sealed" treadmill = ~$90-100 on FB locally

JSON array, one object per lot, same order:
[{"lotId":"id","lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"brief insight"}]`
      }],
    });

    let rawText = message.content[0].text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const lastBrace = rawText.lastIndexOf('}');
      if (lastBrace > 0) {
        try { parsed = JSON.parse(rawText.slice(0, lastBrace + 1) + ']'); } catch { parsed = []; }
      } else { parsed = []; }
    }

    // Enhance each lot with eBay comps in parallel
    const enhanced = await Promise.all(toAnalyze.map(async (lot, i) => {
      const data = parsed[i] || {};
      const aiEstimate = data.totalEstimatedValue || 0;
      const { fbValue, source, ebayPrice, retailPrice } = await getSmartFBValue(lot.title || '', aiEstimate);
      return {
        lotId: lot.lotId,
        key: lot._key,
        result: {
          ...data,
          totalEstimatedValue: fbValue,
          valueSource: source,
          ...(ebayPrice && { ebayAvgPrice: ebayPrice }),
          ...(retailPrice && { retailPrice }),
          items: data.items || [],
          breakdown: calcBid(fbValue, s),
        }
      };
    }));

    for (const { lotId, key, result } of enhanced) {
      setCached(key, result);
      results[lotId] = result;
    }

    return res.json({ results });
  } catch (err) {
    console.error('Batch analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Batch analysis failed.' });
  }
}
