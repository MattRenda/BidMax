import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Server-side cache: itemId → { result, ts }
const serverCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function analyzeBatch(req, res) {
  try {
    const { lots, settings = {} } = req.body;

    if (!lots || !Array.isArray(lots) || lots.length === 0) {
      return res.status(400).json({ error: 'lots array required' });
    }

    const {
      targetMargin = 30,
      fbFee = 5,
      effortCost = 10,
    } = settings;

    // Split into cached vs uncached
    const results = {};
    const toAnalyze = [];

    for (const lot of lots) {
      const cached = serverCache.get(lot.id);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        results[lot.id] = cached.result;
      } else {
        toAnalyze.push(lot);
      }
    }

    // Analyze uncached in chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < toAnalyze.length; i += CHUNK) {
      const chunk = toAnalyze.slice(i, i + CHUNK);
      const chunkResults = await analyzeChunk(chunk, { targetMargin, fbFee, effortCost });

      for (const [id, result] of Object.entries(chunkResults)) {
        results[id] = result;
        serverCache.set(id, { result, ts: Date.now() });
      }
    }

    res.json({ results, cached: lots.length - toAnalyze.length, analyzed: toAnalyze.length });
  } catch (err) {
    console.error('analyzeBatch error:', err);
    res.status(500).json({ error: err.message });
  }
}

async function analyzeChunk(lots, { targetMargin, fbFee, effortCost }) {
  const lotList = lots.map((lot, i) =>
    `${i + 1}. ID:${lot.id} | "${lot.title}"${lot.description ? ` — ${lot.description.slice(0, 100)}` : ''} | Category: ${lot.category || 'unknown'} | Current bid: $${lot.currentBid} | Buyer premium: ${lot.buyerPremium}%`
  ).join('\n');

  const prompt = `You are an expert reseller who sells items on Facebook Marketplace in California. Analyze these auction lots and estimate their Facebook Marketplace resale value.

For each lot, return ONLY a JSON object (no markdown, no explanation) like this:
{
  "results": [
    {
      "id": "ITEM_ID",
      "resaleValue": 45,
      "confidence": "high",
      "note": "one-line reason"
    }
  ]
}

Rules:
- resaleValue = realistic FB Marketplace sold price in the Rocklin/Sacramento area (not retail, not eBay)
- Be conservative — use the price it would actually sell at within 1-2 weeks
- For lot packs, value the whole pack together
- For damaged/incomplete items, discount heavily
- confidence: "high" (brand name, clear value), "medium" (generic), "low" (unclear from title)
- If the item is clearly not resellable (trash, single-use, weird lot), set resaleValue to 0

Lots to analyze:
${lotList}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0]?.text || '';

  // Parse JSON — strip any accidental markdown fences
  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('JSON parse failed:', text.slice(0, 500));
    throw new Error('AI response parse failed');
  }

  // Build results keyed by item ID with full financial calculations
  const results = {};
  for (const item of (parsed.results || [])) {
    const lot = lots.find(l => l.id === item.id);
    if (!lot) continue;

    const resaleValue = Math.round(item.resaleValue || 0);
    const buyerPremiumPct = lot.buyerPremium || 13;

    if (resaleValue === 0) {
      results[lot.id] = {
        resaleValue: 0,
        maxBid: 0,
        estimatedProfit: 0,
        confidence: item.confidence || 'low',
        note: item.note || 'Not resellable',
        worthBidding: false,
      };
      continue;
    }

    // Max bid formula:
    // resaleValue = maxBid * (1 + buyerPremium/100) + fbFee + effortCost + (resaleValue * targetMargin/100)
    // Solving for maxBid:
    // maxBid = (resaleValue - fbFee - effortCost - resaleValue*(targetMargin/100)) / (1 + buyerPremium/100)
    const netAfterFees = resaleValue - fbFee - effortCost - (resaleValue * targetMargin / 100);
    const maxBid = Math.max(0, Math.round(netAfterFees / (1 + buyerPremiumPct / 100)));

    // Estimated profit if winning at current minimum bid
    const currentMinBid = lot.minBid || lot.currentBid || 0;
    const totalCostAtMin = currentMinBid * (1 + buyerPremiumPct / 100) + fbFee + effortCost;
    const estimatedProfit = Math.round(resaleValue - totalCostAtMin);

    results[lot.id] = {
      resaleValue,
      maxBid,
      estimatedProfit,
      confidence: item.confidence || 'medium',
      note: item.note || '',
      worthBidding: maxBid > currentMinBid && estimatedProfit > 0,
    };
  }

  return results;
}
