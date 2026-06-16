import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Facebook Graph API config — set these in Railway env vars.
// FB_PAGE_ID: your BidMax Page's numeric ID
// FB_PAGE_ACCESS_TOKEN: a long-lived Page access token (see setup notes)
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = 'v25.0';

const ROCKLIN_AFFILIATE = '75';
const APP_LANDING = 'https://bidmaxapp.com';

// Pick the day's "find": an active, high-value lot that is currently a genuine
// deal (current bid well below estimated resale). We want something that makes
// a compelling post — real upside, not already bid up.
async function pickDailyFind() {
  const now = Math.floor(Date.now() / 1000);
  const soon = now + 24 * 3600; // prefer lots ending within ~a day (urgency)

  // Get active, valued lots for Rocklin
  const { data, error } = await supabase
    .from('analyzed_lots')
    .select('lot_number, title, image_url, item_url, resell_value, current_bid, ends_at, condition')
    .eq('affiliate_id', ROCKLIN_AFFILIATE)
    .gt('ends_at', now)
    .gt('resell_value', 40)
    .order('resell_value', { ascending: false })
    .limit(100);

  if (error || !data || data.length === 0) return null;

  // Score each lot: favor high resale AND a big gap between resale and current bid
  // (the "deal" factor), with a mild bonus for ending soon (urgency in the post).
  const scored = data
    .map(lot => {
      const resale = lot.resell_value || 0;
      const bid = parseFloat(lot.current_bid) || 0;
      const gap = resale - bid;                  // absolute upside
      const ratio = bid > 0 ? resale / bid : resale; // how good a deal
      const endingSoon = lot.ends_at <= soon ? 1.2 : 1.0;
      const score = gap * Math.min(ratio, 10) * endingSoon;
      return { ...lot, resale, bid, gap, ratio, score };
    })
    // require an actual image and a real upside
    .filter(l => l.image_url && l.gap > 25)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

// Avoid posting the same lot twice — track what we've posted.
async function alreadyPosted(lotNumber) {
  try {
    const { data } = await supabase
      .from('fb_posts')
      .select('lot_number')
      .eq('lot_number', lotNumber)
      .maybeSingle();
    return !!data;
  } catch { return false; }
}

async function recordPost(lotNumber, fbPostId) {
  try {
    await supabase.from('fb_posts').insert({
      lot_number: lotNumber,
      fb_post_id: fbPostId || null,
      posted_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[FB] recordPost error:', e.message);
  }
}

function buildCaption(lot) {
  const resale = Math.round(lot.resale);
  const bid = Math.round(lot.bid);
  const cond = lot.condition && lot.condition !== 'unknown' ? ` (${lot.condition.replace(/_/g, ' ')})` : '';

  // Keep it natural, value-forward, and honest. No hype, just the find.
  const lines = [
    `🛒 Daily Deals from BidMaxApp! — BidRL Rocklin`,
    ``,
    `${lot.title}${cond}`,
    ``,
    `Estimated resale: ~$${resale}`,
    bid > 0 ? `Current bid: $${bid}` : `Bidding just opened`,
    ``,
    `BidMax flags deals like this automatically and tells you the max you can bid and still profit — so you never overpay.`,
    ``,
    `See your max bid + more finds 👉 ${APP_LANDING}`,
    ``,
    `#BidRL #Rocklin #Reselling #Liquidation #FlipForProfit`,
  ];
  return lines.filter(l => l !== undefined).join('\n');
}

// Post a photo with caption to the Page. Using the /photos endpoint posts the
// image directly into the feed (better reach than a link post).
async function postToPage(lot) {
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
    console.error('[FB] Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN — skipping post');
    return null;
  }
  const caption = buildCaption(lot);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${FB_PAGE_ID}/photos`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: lot.image_url,      // Facebook fetches the image from this URL
        caption,
        access_token: FB_PAGE_TOKEN,
      }),
    });
    const json = await res.json();
    if (json.error) {
      console.error('[FB] Post failed:', json.error.message);
      return null;
    }
    console.log(`[FB] Posted find ${lot.lot_number} → post id ${json.post_id || json.id}`);
    return json.post_id || json.id || null;
  } catch (e) {
    console.error('[FB] postToPage error:', e.message);
    return null;
  }
}

// Main entry — called by cron once a day.
export async function postDailyFind() {
  console.log('[FB] Selecting daily find for Rocklin...');
  try {
    let lot = await pickDailyFind();
    if (!lot) {
      console.log('[FB] No suitable find today — skipping.');
      return;
    }
    // Skip if we've already posted this exact lot before; try the next best.
    // (One retry to keep it simple.)
    if (await alreadyPosted(lot.lot_number)) {
      console.log(`[FB] Top find ${lot.lot_number} already posted — skipping today.`);
      return;
    }
    const postId = await postToPage(lot);
    if (postId) await recordPost(lot.lot_number, postId);
  } catch (e) {
    console.error('[FB] postDailyFind error:', e.message);
  }
}
