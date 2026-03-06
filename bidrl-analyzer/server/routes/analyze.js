import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Server-side cache: lotId → {result, timestamp} ──
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCached(key, data) {
  // Keep cache from growing unbounded
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
  cache.set(key, { data, ts: Date.now() });
}

function calcBid(total, { targetMargin, buyersPremium, fbFee, effortCost }) {
  const fbFeeAmt = total * (fbFee / 100);
  const profitAmt = total * (targetMargin / 100);
  const maxBid = Math.max(0, Math.floor((total - fbFeeAmt - profitAmt - effortCost) / (1 + buyersPremium / 100)));
  return {
    estimatedSaleValue: total,
    fbFee: Math.round(fbFeeAmt),
    targetProfit: Math.round(profitAmt),
    effortCost,
    buyersPremium: `${buyersPremium}%`,
    maxBid,
    expectedProfit: Math.round(total - maxBid * (1 + buyersPremium / 100) - fbFeeAmt - effortCost),
  };
}

// ── Single lot analysis (kept for detail page / fallback) ──
export async function analyzeLot(req, res) {
  const { description, lotId, settings } = req.body;

  if (!description || description.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a lot description.' });
  }

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };

  // Cache check
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

Rules: estimatedValue = realistic LOCAL Facebook Marketplace price (40-60% of retail). Be conservative. Condition unclear = fair.`
      }],
    });

    const text = message.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    const result = { ...parsed, breakdown: calcBid(parsed.totalEstimatedValue || 0, s) };

    setCached(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
}

// ── BATCH: analyze up to 24 lots in ONE API call ──
export async function analyzeBatch(req, res) {
  const { lots, settings } = req.body;

  if (!lots || !Array.isArray(lots) || lots.length === 0) {
    return res.status(400).json({ error: 'No lots provided.' });
  }

  const s = { targetMargin: 30, buyersPremium: 15, fbFee: 5, effortCost: 10, ...settings };

  // Split into cached vs needs-analysis
  const results = {};
  const toAnalyze = [];

  for (const lot of lots) {
    const key = lot.lotId || lot.title?.slice(0, 60) || String(Math.random());
    const cached = getCached(key);
    if (cached) {
      results[lot.lotId] = { ...cached, cached: true };
    } else {
      toAnalyze.push({ ...lot, _key: key });
    }
  }

  if (toAnalyze.length === 0) {
    return res.json({ results });
  }

  // Build a single prompt with all lots
  const lotsText = toAnalyze.map((lot, i) =>
    `LOT_${i}: [${lot.lotId || 'unknown'}] ${lot.title}${lot.currentBid ? ` | Current bid: $${lot.currentBid}` : ''}${lot.minBid ? ` | Min bid: $${lot.minBid}` : ''}`
  ).join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: Math.min(120 * toAnalyze.length + 200, 4096),
      messages: [{
        role: 'user',
        content: `Expert reseller. Estimate realistic LOCAL Facebook Marketplace resale value for each lot (40-60% retail, conservative). Return ONLY a JSON array, no markdown.

${lotsText}

JSON array, one object per lot, same order:
[{"lotId":"id","lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"brief insight"}]

Local FB prices only. Conservative estimates. No items array.`
      }],
    });

    let rawText = message.content[0].text.replace(/```json|```/g, '').trim();
    
    // If truncated, try to recover by closing the JSON array
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Try to recover truncated JSON by finding last complete object
      const lastBrace = rawText.lastIndexOf('}');
      if (lastBrace > 0) {
        try {
          parsed = JSON.parse(rawText.slice(0, lastBrace + 1) + ']');
        } catch {
          parsed = [];
        }
      } else {
        parsed = [];
      }
    }

    // Map results back by lotId
    for (let i = 0; i < toAnalyze.length; i++) {
      const lot = toAnalyze[i];
      const data = parsed[i] || {};
      const result = {
        ...data,
        items: data.items || [],
        breakdown: calcBid(data.totalEstimatedValue || 0, s),
      };
      setCached(lot._key, result);
      results[lot.lotId] = result;
    }

    return res.json({ results });
  } catch (err) {
    console.error('Batch analyze error:', err.message);
    // Fall back to returning empty so extension can degrade gracefully
    return res.status(500).json({ error: err.message || 'Batch analysis failed.' });
  }
}
