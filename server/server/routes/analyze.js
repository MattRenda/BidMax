import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Fetch image as base64 ──
async function fetchImageBase64(url) {
  try {
    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { base64, mediaType: contentType.split(';')[0] };
  } catch {
    return null;
  }
}

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

  // Apply aggressive safety margin — AI estimates are unreliable, protect the buyer
  let safeBid = maxBid;
  if (maxBid > 100) safeBid = Math.floor(maxBid * 0.75); // 25% haircut over $100
  if (maxBid > 300) safeBid = Math.floor(maxBid * 0.65); // 35% haircut over $300
  if (maxBid > 500) safeBid = Math.floor(maxBid * 0.55); // 45% haircut over $500

  const safeTotalCost = Math.round(safeBid * premium + effortCost + fbFeeAmt);
  const safeProfit = Math.round(total - safeTotalCost);

  return {
    estimatedSaleValue: total,
    fbFee: Math.round(fbFeeAmt),
    effortCost,
    buyersPremium: `${buyersPremium}%`,
    maxBid: safeBid,
    expectedProfit: safeProfit,
    roi: safeTotalCost > 0 ? Math.round((safeProfit / safeTotalCost) * 100) : 0,
  };
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
        content: `You are an expert reseller who knows actual retail prices of products.

Lot: "${description}"

Step 1: Identify what this item actually is and what it actually retails for new (ignore any retail price claimed in the title — BidRL sellers often fabricate these).
Step 2: Estimate the Facebook Marketplace resale price for a used/unknown condition item that needs to sell in 1-2 weeks locally.

Apply these FB Marketplace discounts to ACTUAL retail (not claimed retail):
- Used/unknown condition = 25-35% of actual retail
- Large outdoor items (grills, mowers, patio) = 20-28% of actual retail
- Large furniture = 20-28% of actual retail
- Power tools = 35-48% of actual retail
- Small appliances = 28-40% of actual retail
- Electronics sealed = 42-55% of actual retail
- Factory sealed = 50-55% of actual retail

Return ONLY valid JSON, no markdown:
{"lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"actual retail ~$X, FB resell at Y% = $Z"}`
      }],
    });
    const text = message.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const result = { ...parsed, valueSource: 'ai', breakdown: calcBid(parsed.totalEstimatedValue || 0, s) };
    setCached(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
}

// ── BATCH analysis ──
export async function analyzeBatch(req, res) {
  const { lots, settings, deviceId, sessionToken, fromCache, personalBypass } = req.body;
  const isPersonalBypass = personalBypass === 'matthew-pro-bypass';
  if (!lots || !Array.isArray(lots) || lots.length === 0) return res.status(400).json({ error: 'No lots provided.' });

  const uncachedCount = lots.filter(lot => {
    const key = lot.lotId || lot.title?.slice(0, 60);
    return !getCached(key);
  }).length;

  if (!isPersonalBypass && !fromCache && uncachedCount > 0 && (deviceId || sessionToken)) {
    let userId = null;
    try {
      const { validateSession, checkAndIncrementUsage } = await import('./auth.js');
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
      console.error('Usage check error:', err);
    }
  }

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

  // Strip claimed retail from titles — BidRL sellers frequently fabricate these
  const lotsText = toAnalyze.map(lot => {
    const cleanTitle = lot.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    const imgPart = lot.imageUrl ? ` | Image: ${lot.imageUrl}` : '';
    return `${lot.lotId}: ${cleanTitle}${lot.currentBid ? ` | Current bid: $${lot.currentBid}` : ''}${imgPart}`;
  }).join('\n');

  try {
    // Fetch images in parallel for vision analysis
    const imageData = await Promise.all(
      toAnalyze.map(lot => lot.imageUrl ? fetchImageBase64(lot.imageUrl) : Promise.resolve(null))
    );

    // Build vision content — text prompt + images for each lot
    const promptText = `You are an expert reseller who knows actual retail prices of products.

For each lot below, use the provided images AND titles to:
1. Identify the exact item (brand, model if visible)
2. Assess condition from the image (new, like new, good, fair, poor)
3. Estimate the Facebook Marketplace resale price to SELL IN 1-2 WEEKS locally in California

IMPORTANT: Use your real knowledge of actual retail prices — ignore any prices claimed in titles, they are frequently fabricated.

${lotsText}

Apply these FB Marketplace discounts to ACTUAL retail price:
- New/sealed = 50-55% of actual retail
- Like new = 40-50% of actual retail
- Good condition = 30-40% of actual retail
- Fair/poor condition = 15-25% of actual retail
- Large outdoor items (grills, mowers) = 20-28% of actual retail regardless of condition
- Large furniture = 20-28% of actual retail
- Power tools (DeWalt, Milwaukee, Makita, Ryobi) = 35-48% of actual retail
- Generic/no-name items = use lower end of range

Return ONLY a JSON array, no markdown, one object per lot, same order:
[{"lotId":"EXACT_ID","lotTitle":"short title","totalEstimatedValue":85,"condition":"good","lotNotes":"identified as X, actual retail ~$Y, FB resell at Z%"}]`;

    // Build content array with text + images interleaved
    const contentBlocks = [{ type: 'text', text: promptText }];
    toAnalyze.forEach((lot, i) => {
      const img = imageData[i];
      if (img) {
        contentBlocks.push({
          type: 'text',
          text: `Image for ${lot.lotId}:`
        });
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
        });
      }
    });

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: Math.min(150 * toAnalyze.length + 200, 4096),
      messages: [{ role: 'user', content: contentBlocks }],
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

    for (const [i, lot] of toAnalyze.entries()) {
      const data = parsed[i] || {};
      let fbValue = data.totalEstimatedValue;
      // Strip dollar sign if Claude returned "$380" instead of 380
      if (typeof fbValue === 'string') fbValue = parseFloat(fbValue.replace(/[$,]/g, '')) || 0;
      fbValue = fbValue || 0;
      const result = {
        ...data,
        lotId: lot.lotId,
        totalEstimatedValue: fbValue,
        valueSource: 'ai',
        items: data.items || [],
        breakdown: calcBid(fbValue, s),
      };
      setCached(lot._key, result);
      results[lot.lotId] = result;
    }

    return res.json({ results });
  } catch (err) {
    console.error('Batch analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Batch analysis failed.' });
  }
}
