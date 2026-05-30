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
async function analyzeBatchWithVision(items) {
  const imageData = await Promise.all(
    items.map(item => item.thumb_url ? fetchImageBase64(item.thumb_url) : Promise.resolve(null))
  );

  const lotsText = items.map(item => {
    const cleanTitle = item.title.replace(/[-–—]?\s*retail\s*\$?[\d,]+(\.\d+)?/gi, '').trim();
    return `${item.lot_number}: ${cleanTitle}${item.current_bid ? ` | Bid: $${item.current_bid}` : ''}`;
  }).join('\n');

  const contentBlocks = [{
    type: 'text',
    text: `You are an expert reseller. For each lot, use the image AND title to identify the item and estimate its Facebook Marketplace resale price to sell in 1-2 weeks locally in California.

IMPORTANT: Ignore any retail prices in titles — they are often fabricated. Use your real knowledge of actual retail prices.

${lotsText}

Discounts from ACTUAL retail:
- New/sealed = 50-55%, Like new = 40-50%, Good = 30-40%, Fair/poor = 15-25%
- Large outdoor (grills, mowers) = 20-28%, Large furniture = 20-28%
- Power tools = 35-48%, Small appliances = 28-40%, Electronics sealed = 42-55%
- Generic/no-name = lower end of range

Return ONLY a JSON array, same order:
[{"lotId":"ID","lotTitle":"short title","totalEstimatedValue":85,"condition":"good","lotNotes":"actual retail ~$X, FB at Y%"}]`
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
    max_tokens: Math.min(150 * items.length + 200, 4096),
    messages: [{ role: 'user', content: contentBlocks }],
  });

  let rawText = message.content[0].text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(rawText);
  } catch {
    const lastBrace = rawText.lastIndexOf('}');
    if (lastBrace > 0) {
      try { return JSON.parse(rawText.slice(0, lastBrace + 1) + ']'); } catch {}
    }
    return [];
  }
}

// Main scan function for one affiliate
async function scanAffiliate(affiliateId) {
  console.log(`[Scan] Starting affiliate ${affiliateId}`);

  // Log scan start
  const { data: scanLog } = await supabase
    .from('scan_log')
    .insert({ affiliate_id: affiliateId, status: 'running' })
    .select().single();

  try {
    const allItems = await fetchAllItems(affiliateId);
    console.log(`[Scan] Fetched ${allItems.length} unique items`);

    // Process in batches of 24
    const BATCH_SIZE = 24;
    let totalAnalyzed = 0;
    const upsertRows = [];

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      const batch = allItems.slice(i, i + BATCH_SIZE);
      console.log(`[Scan] Analyzing batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(allItems.length/BATCH_SIZE)}`);

      try {
        const results = await analyzeBatchWithVision(batch);

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
      } catch(e) {
        console.error(`[Scan] Batch error:`, e.message);
      }

      // Small delay between batches
      if (i + BATCH_SIZE < allItems.length) await new Promise(r => setTimeout(r, 1000));
    }

    // Upsert all results to Supabase
    if (upsertRows.length > 0) {
      const { error } = await supabase
        .from('analyzed_lots')
        .upsert(upsertRows, { onConflict: 'lot_number,affiliate_id' });
      if (error) console.error('[Scan] Supabase upsert error:', error.message);
    }

    // Update scan log
    await supabase.from('scan_log').update({
      items_scanned: allItems.length,
      items_analyzed: totalAnalyzed,
      completed_at: new Date().toISOString(),
      status: 'completed',
    }).eq('id', scanLog.id);

    console.log(`[Scan] Affiliate ${affiliateId} done: ${totalAnalyzed}/${allItems.length} analyzed`);
  } catch(e) {
    console.error(`[Scan] Affiliate ${affiliateId} failed:`, e.message);
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

// Get top picks from DB for an affiliate
export async function getTopPicks(req, res) {
  const { affiliateId } = req.query;
  if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });

  try {
    // Get items analyzed in last 24 hours, sorted by resell value
    const { data, error } = await supabase
      .from('analyzed_lots')
      .select('*')
      .eq('affiliate_id', String(affiliateId))
      .gte('analyzed_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
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
