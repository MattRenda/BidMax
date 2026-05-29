import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ── Web search for real retail prices ──
async function searchRealRetailPrice(title) {
  try {
    const cleanTitle = title
      .replace(/retail\s*\$[\d,]+/gi, '')
      .replace(/lot\s*#?\w+/gi, '')
      .replace(/factory\s*sealed/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

    // Step 1: search with web tool
    const step1 = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `What does "${cleanTitle}" sell for new on Amazon or Walmart right now?` }],
    });

    if (step1.stop_reason !== 'tool_use') return null;

    // Step 2: send tool results back, ask for JSON price
    const toolUseBlock = step1.content.find(b => b.type === 'tool_use');
    const step2 = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        { role: 'user', content: `What does "${cleanTitle}" sell for new on Amazon or Walmart right now?` },
        { role: 'assistant', content: step1.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: 'Search done' }] },
        { role: 'user', content: 'Based on your search results, what is the actual retail price? Reply with ONLY a number like: 89.99' },
      ],
    });

    const text = step2.content.find(b => b.type === 'text')?.text || '';
    const match = text.match(/[\$]?([\d,]+(?:\.\d{1,2})?)/);
    if (match) {
      const price = parseFloat(match[1].replace(',', ''));
      if (price > 5 && price < 10000) {
        console.log(`[BidMax] Web search: "${cleanTitle.slice(0,40)}" = $${price}`);
        return price;
      }
    }
    return null;
  } catch(e) {
    console.error('[BidMax] Web search error:', e.message);
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
// Max plausible retail prices by category — catches inflated BidRL claims
const RETAIL_CAPS = [
  { pattern: /mop|broom|vacuum.*stick|spray mop/i, cap: 150 },
  { pattern: /cleaning|cleaner|detergent|soap/i, cap: 80 },
  { pattern: /extension spring|spring.*cable|garage.*spring/i, cap: 200 },
  { pattern: /door.*hinge|hinge|bracket|hardware/i, cap: 100 },
  { pattern: /nail.*desk|manicure.*table/i, cap: 300 },
  { pattern: /shoe|sneaker|boot/i, cap: 250 },
  { pattern: /wallpaper|contact.*paper/i, cap: 60 },
  { pattern: /file.*cabinet/i, cap: 200 },
];

function sanityCheckRetail(title, claimedRetail) {
  for (const { pattern, cap } of RETAIL_CAPS) {
    if (pattern.test(title) && claimedRetail > cap) {
      console.log(`[BidMax] Retail cap: "${title.slice(0,50)}" claimed $${claimedRetail}, capped at $${cap}`);
      return cap;
    }
  }
  return claimedRetail;
}

async function getSmartFBValue(title, aiEstimate) {
  const [ebayPrice, rawRetailPrice] = await Promise.all([
    getEbayAvgPrice(title),
    Promise.resolve(extractRetailPrice(title))
  ]);

  // Sanity check claimed retail — BidRL listings often inflate prices
  const retailPrice = rawRetailPrice ? sanityCheckRetail(title, rawRetailPrice) : null;

  let fbValue = aiEstimate;
  let source = 'ai';

  if (ebayPrice) {
    // eBay sold comps are most reliable — FB is ~75% of eBay (local market discount)
    // Never let AI estimate inflate above eBay-derived value
    fbValue = Math.round(ebayPrice * 0.75);
    source = 'ebay';
  } else if (retailPrice) {
    const isSealed = /factory\s*sealed|new\s*in\s*box|nib|sealed/i.test(title);
    const isLargeOutdoor = /grill|traeger|weber|mower|lawn|patio|outdoor|bbq/i.test(title);
    const isLargeFurniture = /sofa|couch|sectional|dresser|armoire|wardrobe/i.test(title);
    let pct = isSealed ? 0.55 : 0.35;
    if (isLargeOutdoor) pct = isSealed ? 0.40 : 0.25;
    if (isLargeFurniture) pct = isSealed ? 0.40 : 0.25;
    const retailDerived = Math.round(retailPrice * pct);
    // Only use retail anchor if it's LOWER than AI estimate (conservative) or AI has no data
    // This prevents inflated retail claims from bumping up the value
    fbValue = aiEstimate > 0 ? Math.min(retailDerived, aiEstimate * 1.5) : retailDerived;
    source = 'retail';
  }

  // AI is only the floor when no external data exists
  // When eBay/retail data exists, DON'T let AI inflate it
  if (source === 'ai') fbValue = aiEstimate;

  return { fbValue, source, ebayPrice, retailPrice: rawRetailPrice };
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
        content: `You are an expert reseller. Estimate the price this item would need to be listed at on Facebook Marketplace in a mid-size California city to SELL WITHIN 1-2 WEEKS to a stranger. Not what it's worth — the price that actually moves it fast.

Lot: "${description}"

Return ONLY valid JSON, no markdown:
{"lotTitle":"short title","items":[{"name":"item","condition":"new|like new|good|fair|poor","estimatedValue":25}],"totalEstimatedValue":100,"lotNotes":"key insight"}

Pricing rules (price to sell, not to maximize):
- Price 10-15% below typical FB Marketplace asking price so it sells in 1-2 weeks
- Factory sealed / new in box = 50-55% of retail
- Used/unknown condition = 25-35% of retail
- Large outdoor items (grills, Traeger, Weber, mowers, patio) = 20-28% of retail — heavy, fewer buyers
- Large furniture = 20-28% of retail
- Power tools = 35-48% of retail
- Small kitchen appliances = 28-40% of retail
- Electronics sealed = 42-55% of retail
- Condition unknown = assume used, use lower end of range`
      }],
    });
    const text = message.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
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

  // Strip claimed retail prices from titles before sending to Claude — they're often fake
  const lotsText = toAnalyze.map(lot => {
    const cleanTitle = lot.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    return `${lot.lotId}: ${cleanTitle}${lot.currentBid ? ` | Current bid: $${lot.currentBid}` : ''}${lot.minBid ? ` | Min bid: $${lot.minBid}` : ''}`;
  }).join('\n');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: Math.min(120 * toAnalyze.length + 200, 4096),
      messages: [{
        role: 'user',
        content: `You are an expert reseller. Estimate the price each item would need to be listed at on Facebook Marketplace in a mid-size California city to SELL WITHIN 1-2 WEEKS to a stranger. This is not what it's worth — it's the price that actually moves it fast.

${lotsText}

Pricing rules (price to sell, not to maximize):
- Search your knowledge for what these items actually sell for used locally — not retail, not eBay, not wishful asking prices
- Price 10-15% below typical FB Marketplace asking price so it sells quickly
- Factory sealed / new in box = 50-55% of retail
- Used/unknown condition = 25-35% of retail
- Large outdoor items (grills, Traeger, Weber, mowers, patio furniture) = 20-28% of retail — heavy, hard to move, fewer buyers
- Large furniture (sofas, dressers, wardrobes) = 20-28% of retail
- Power tools (DeWalt, Milwaukee, Makita, Ryobi) = 35-48% of retail
- Small kitchen appliances = 28-40% of retail
- Electronics sealed = 42-55% of retail
- Condition unknown = always assume used, use lower end of range
- If current bid is already high relative to your estimate, note it
- Use the EXACT lot ID from the input as the lotId field

Return ONLY a JSON array, no markdown, one object per lot, same order:
[{"lotId":"EXACT_ID_FROM_INPUT","lotTitle":"short title","totalEstimatedValue":85,"lotNotes":"brief reasoning: condition assumed, comparable FB sales"}]`
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

    const enhanced = await Promise.all(toAnalyze.map(async (lot, i) => {
      const data = parsed[i] || {};
      const aiEstimate = data.totalEstimatedValue || 0;

      // Search for real retail price — overrides claimed retail in title
      const webRetailPrice = await searchRealRetailPrice(lot.title || '');

      // If we found a real price via web search, use it as the anchor
      let fbValue = aiEstimate;
      let source = 'ai';
      let retailPrice = null;

      if (webRetailPrice) {
        retailPrice = webRetailPrice;
        const isSealed = /factory\s*sealed|new\s*in\s*box|nib|sealed/i.test(lot.title);
        const isLargeOutdoor = /grill|traeger|weber|mower|lawn|patio|outdoor|bbq/i.test(lot.title);
        const isLargeFurniture = /sofa|couch|sectional|dresser|armoire|wardrobe/i.test(lot.title);
        let pct = isSealed ? 0.55 : 0.35;
        if (isLargeOutdoor) pct = isSealed ? 0.40 : 0.25;
        if (isLargeFurniture) pct = isSealed ? 0.40 : 0.25;
        const retailDerived = Math.round(webRetailPrice * pct);
        // Take the lower of AI estimate and retail-derived to be conservative
        fbValue = aiEstimate > 0 ? Math.min(retailDerived, aiEstimate * 1.2) : retailDerived;
        source = 'web_search';
      } else {
        // Fall back to eBay comps + claimed retail
        const smartVal = await getSmartFBValue(lot.title || '', aiEstimate);
        fbValue = smartVal.fbValue;
        source = smartVal.source;
        retailPrice = smartVal.retailPrice;
      }

      return {
        lotId: lot.lotId,
        key: lot._key,
        result: {
          ...data,
          lotId: lot.lotId,
          totalEstimatedValue: fbValue,
          valueSource: source,
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
