import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

// Fetch image as base64
async function fetchImageBase64(url) {
  try {
    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const buffer = await res.arrayBuffer();
    return { base64: Buffer.from(buffer).toString('base64'), mediaType: contentType.split(';')[0] };
  } catch { return null; }
}

// Analyze a batch of items with vision
// Step 1: identify items from images
async function identifyItems(items, imageData) {
  const lotsText = items.map(item => {
    const cleanTitle = item.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    return `${item.lot_number}: ${cleanTitle}`;
  }).join('\n');

  const contentBlocks = [{
    type: 'text',
    text: `Look at each image and identify the exact product — brand, model number, and approximate retail price. Be specific.

${lotsText}

Return ONLY a JSON array, same order:
[{"lotId":"ID","brand":"MERACH","model":"W50","retailPrice":290,"condition":"new/sealed","confidence":"high|medium|low"}]

If you cannot identify the item, use confidence "low" and estimate retailPrice from category knowledge.`
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
    max_tokens: Math.min(100 * items.length + 200, 4096),
    messages: [{ role: 'user', content: contentBlocks }],
  });

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

// Step 2: web search retail price for high-confidence identifications
// Cache web search results to avoid duplicate searches within a scan
const searchCache = new Map();

async function searchRetailPrice(brand, model) {
  const key = `${brand} ${model}`.toLowerCase();
  if (searchCache.has(key)) {
    console.log(`[Scan] Cache hit: ${brand} ${model} = $${searchCache.get(key)}`);
    return searchCache.get(key);
  }
  try {
    const query = `${brand} ${model} price`;
    const step1 = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Search for the current retail price of the ${brand} ${model}. What does it sell for new on Amazon or Walmart?` }],
    });

    // Extract all $ amounts from search results and Claude's text
    const allText = step1.content
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
      .map(m => parseFloat(m[1].replace(',', '')))
      .filter(p => p > 20 && p < 5000);

    if (prices.length > 0) {
      prices.sort((a, b) => a - b);
      const price = prices[Math.floor(prices.length / 2)];
      console.log(`[Scan] Web search: ${brand} ${model} = $${price}`);
      searchCache.set(key, price);
      return price;
    }
    return null;
  } catch(e) {
    console.error('[Scan] Web search error:', e.message);
    return null;
  }
}

async function analyzeBatchWithVision(items) {
  const imageData = await Promise.all(
    items.map(item => item.thumb_url ? fetchImageBase64(item.thumb_url) : Promise.resolve(null))
  );

  // Step 1: identify items from images
  const identifications = await identifyItems(items, imageData);

  // Step 2: web search retail prices with concurrency limit to avoid rate limits
  const retailPrices = new Array(identifications.length).fill(null);
  const CONCURRENCY = 3;

  const searchTasks = identifications
    .map((id, i) => ({ id, i }))
    .filter(({ id }) => id?.confidence === 'high' && id?.brand && id?.model);

  for (let i = 0; i < searchTasks.length; i += CONCURRENCY) {
    const chunk = searchTasks.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async ({ id, i: idx }) => {
      const searched = await searchRetailPrice(id.brand, id.model);
      retailPrices[idx] = searched || id?.retailPrice || null;
    }));
    if (i + CONCURRENCY < searchTasks.length) await new Promise(r => setTimeout(r, 2000));
  }

  // Fill in non-searched items with AI estimates
  identifications.forEach((id, i) => {
    if (retailPrices[i] === null) retailPrices[i] = id?.retailPrice || null;
  });

  // Step 3: calculate FB resell value using verified retail prices
  const results = identifications.map((id, i) => {
    if (!id) return null;
    const item = items[i];
    const retail = retailPrices[i] || id.retailPrice || 0;
    const condition = id.condition || 'unknown';

    let pct = 0.30; // default used
    if (condition.includes('sealed') || condition.includes('new')) pct = 0.52;
    else if (condition.includes('like new')) pct = 0.45;
    else if (condition.includes('good')) pct = 0.35;
    else if (condition.includes('fair') || condition.includes('poor')) pct = 0.20;

    // Category overrides
    const title = item.title.toLowerCase();
    if (/grill|traeger|weber|mower|patio/.test(title)) pct = Math.min(pct, 0.28);
    if (/sofa|couch|sectional|dresser/.test(title)) pct = Math.min(pct, 0.28);

    const resellValue = retail > 0 ? Math.round(retail * pct) : 0;

    return {
      lotId: item.lot_number,
      lotTitle: `${id.brand || ''} ${id.model || ''}`.trim() || item.title.slice(0, 50),
      totalEstimatedValue: resellValue,
      condition,
      lotNotes: `${id.brand || ''} ${id.model || ''} | retail ~$${retail} | ${Math.round(pct*100)}% FB = $${resellValue}`,
    };
  }).filter(Boolean);

  return results;
}

// Main scan function for one affiliate
async function scanAffiliate(affiliateId) {
  console.log(`[Scan] Starting affiliate ${affiliateId}`);

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
    const newItems = allItems.filter(i => !existingMap.has(i.lot_number));
    const existingItems = allItems.filter(i => existingMap.has(i.lot_number));

    console.log(`[Scan] ${newItems.length} new items to analyze, ${existingItems.length} existing (bid refresh only)`);

    // Refresh bids for existing items — no Claude needed
    if (existingItems.length > 0) {
      const bidUpdates = existingItems.map(item => ({
        lot_number: item.lot_number,
        affiliate_id: String(affiliateId),
        current_bid: parseFloat(item.current_bid) || 0,
        ends_at: parseInt(item.ends) || null,
      }));
      for (let i = 0; i < bidUpdates.length; i += 100) {
        await supabase.from('analyzed_lots')
          .upsert(bidUpdates.slice(i, i + 100), { onConflict: 'lot_number,affiliate_id' });
      }
      console.log(`[Scan] Updated bids for ${existingItems.length} existing items`);
    }

    // Full vision + web search analysis for new items only
    const BATCH_SIZE = 24;
    let totalAnalyzed = 0;

    for (let i = 0; i < newItems.length; i += BATCH_SIZE) {
      const batch = newItems.slice(i, i + BATCH_SIZE);
      console.log(`[Scan] Analyzing batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(newItems.length/BATCH_SIZE)}`);

      try {
        const results = await analyzeBatchWithVision(batch);

        const upsertRows = [];
        for (const [j, item] of batch.entries()) {
          const result = results[j] || {};
          let resellValue = result.totalEstimatedValue;
          if (typeof resellValue === 'string') resellValue = parseFloat(resellValue.replace(/[$,]/g, '')) || 0;

          if (resellValue > 0) {
            upsertRows.push({
              lot_number: item.lot_number,
              affiliate_id: String(affiliateId),
              auction_id: item.auction_id,
              auction_title: item.auction_title,
              title: item.title,
              image_url: item.thumb_url || null,
              item_url: item.item_url,
              current_bid: parseFloat(item.current_bid) || 0,
              minimum_bid: parseFloat(item.minimum_bid) || 0,
              ends_at: parseInt(item.ends) || null,
              resell_value: Math.round(resellValue),
              condition: result.condition || 'unknown',
              lot_notes: result.lotNotes || null,
              analyzed_at: new Date().toISOString(),
            });
            totalAnalyzed++;
          }
        }

        if (upsertRows.length > 0) {
          await supabase.from('analyzed_lots')
            .upsert(upsertRows, { onConflict: 'lot_number,affiliate_id' });
        }
      } catch(e) {
        console.error(`[Scan] Batch error:`, e.message);
      }

      if (i + BATCH_SIZE < newItems.length) await new Promise(r => setTimeout(r, 1000));
    }

    await supabase.from('scan_log').update({
      items_scanned: allItems.length,
      items_analyzed: totalAnalyzed,
      completed_at: new Date().toISOString(),
      status: 'completed',
    }).eq('id', scanLog.id);

    console.log(`[Scan] Done: ${totalAnalyzed} new, ${existingItems.length} bid-refreshed`);
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

    // Update current_bid and ends_at for existing DB records only
    const updates = allItems.map(item => ({
      lot_number: item.lot_number,
      affiliate_id: String(affiliateId),
      current_bid: parseFloat(item.current_bid) || 0,
      ends_at: parseInt(item.ends) || null,
    }));

    // Upsert in chunks of 100
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100);
      const { error } = await supabase
        .from('analyzed_lots')
        .upsert(chunk, { onConflict: 'lot_number,affiliate_id', ignoreDuplicates: false });
      if (error) console.error('[Refresh] Upsert error:', error.message);
    }

    console.log(`[Refresh] Updated ${updates.length} bids for affiliate ${affiliateId}`);
  } catch(e) {
    console.error(`[Refresh] Error:`, e.message);
  }
}

// Scan a single affiliate (called by cron)
export async function runScanForAffiliate(affiliateId) {
  await scanAffiliate(affiliateId);
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

// GET /api/lot/:lotNumber — get single lot analysis from DB
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

// Get top picks from DB for an affiliate
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
