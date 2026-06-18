import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Sender must be on a Resend-VERIFIED domain. bidmaxapp.com (root) is verified
// in Resend, so we default to it. (Earlier this defaulted to send.bidmaxapp.com,
// a subdomain that was NOT verified in Resend, causing sends to fail.)
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'BidMax Alerts <alerts@bidmaxapp.com>';
const APP_LANDING = 'https://bidmaxapp.com';
const BUSINESS_ADDRESS = 'BidMax LLC, 9033 Farmstead Cir, Roseville, CA 95747';

// Only alert on lots ending within this window (seconds). 1 hour per spec.
const ENDING_WINDIN_SEC = 60 * 60;
const ROCKLIN_AFFILIATE = '75';

// ── Fire-deal logic — ported VERBATIM from the app (services/api.ts) ──
// Must stay identical to the client so the email flags exactly what the app
// flags. fireThreshold is a DOLLAR amount; expectedProfit is profit at the
// user's MAX bid (not the current bid). Rounding: maxBid floor, cost/profit round.
function calcBid(resaleValue, targetMargin = 30, buyersPremium = 15) {
  const sale = Number.isFinite(resaleValue) ? resaleValue : 0;
  const roi = (Number.isFinite(targetMargin) ? targetMargin : 30) / 100;
  const premium = 1 + (Number.isFinite(buyersPremium) ? buyersPremium : 15) / 100;
  const maxBid = Math.max(0, Math.floor(sale / premium / (1 + roi)));
  const totalCost = Math.round(maxBid * premium);
  const expectedProfit = Math.round(sale - totalCost);
  return { maxBid, totalCost, expectedProfit };
}

function isFireDeal(resaleValue, currentBid, targetMargin = 30, buyersPremium = 15, fireThreshold = 50) {
  if (resaleValue == null) return false;
  const { maxBid, expectedProfit } = calcBid(resaleValue, targetMargin, buyersPremium);
  const worth = maxBid > 0 && currentBid < maxBid;
  return worth && expectedProfit >= fireThreshold;
}

// Send one email via Resend. Returns true on success.
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error('[Alerts] RESEND_API_KEY not set — cannot send');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    const json = await res.json();
    if (json.id) return { ok: true };
    const detail = json.message || json.name || JSON.stringify(json);
    console.error('[Alerts] Resend error:', detail, '| from:', FROM_EMAIL);
    return { ok: false, error: detail };
  } catch (e) {
    console.error('[Alerts] send error:', e.message);
    return { ok: false, error: e.message };
  }
}

function minutesLeft(endsAt) {
  return Math.max(0, Math.round((endsAt - 2 * 3600 - Date.now() / 1000) / 60));
  // note: ends_at is stored as raw bidrl end + 7200 (2h) offset elsewhere; we
  // subtract it back out here to get true minutes remaining.
}

function buildEmail(user, lot) {
  const { maxBid, expectedProfit } = calcBid(
    lot.resell_value, user.target_margin, user.buyers_premium
  );
  const mins = minutesLeft(lot.ends_at);
  const unsubUrl = `${APP_LANDING}/unsubscribe?u=${encodeURIComponent(user.id)}`;
  return {
    subject: `🔥 Fire deal ending soon: ${lot.title.slice(0, 60)}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
        <h2 style="color:#dc2626;">🔥 Fire Deal Ending Soon</h2>
        <p style="font-size:16px;font-weight:600;">${lot.title}</p>
        ${lot.image_url ? `<img src="${lot.image_url}" alt="" style="width:100%;max-width:480px;border-radius:8px;">` : ''}
        <table style="width:100%;font-size:15px;margin:16px 0;">
          <tr><td>Estimated resale</td><td style="text-align:right;font-weight:600;">$${Math.round(lot.resell_value)}</td></tr>
          <tr><td>Current bid</td><td style="text-align:right;">$${Math.round(lot.current_bid)}</td></tr>
          <tr><td>Your max bid</td><td style="text-align:right;font-weight:600;">$${maxBid}</td></tr>
          <tr><td>Profit at your max</td><td style="text-align:right;color:#16a34a;font-weight:600;">$${expectedProfit}</td></tr>
          <tr><td>Time left</td><td style="text-align:right;color:#dc2626;font-weight:600;">~${mins} min</td></tr>
        </table>
        <a href="${lot.item_url || APP_LANDING}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View Lot on BidRL</a>
        <p style="font-size:12px;color:#64748b;margin-top:24px;">
          You're receiving this because you enabled Fire Deal alerts in BidMax.
          <a href="${unsubUrl}">Unsubscribe</a><br>${BUSINESS_ADDRESS}
        </p>
      </div>`,
  };
}

// Main entry — called by cron every ~15 min.
// Send a TEST alert email on demand, bypassing the time-window and dedup checks.
// Used by the /admin/test-alert endpoint to verify Resend delivery + rendering.
// If a lotNumber is given, uses that real lot; otherwise builds a sample lot.
export async function sendTestAlert(toEmail, lotNumber = null) {
  // Build the user context with default settings for the calc
  const user = { id: 'test', email: toEmail, target_margin: 30, buyers_premium: 15 };

  let lot;
  if (lotNumber) {
    const { data } = await supabase
      .from('analyzed_lots')
      .select('lot_number, title, image_url, item_url, resell_value, current_bid, ends_at')
      .eq('lot_number', lotNumber)
      .maybeSingle();
    if (!data) return { ok: false, error: `Lot ${lotNumber} not found` };
    lot = data;
  } else {
    // Sample lot so you can test with no real data
    lot = {
      lot_number: 'TEST000',
      title: 'TEST — Ninja Woodfire Pro Connect Premium XL Outdoor Grill & Smoker',
      image_url: 'https://upwjsmlsrbxukxsewyme.supabase.co/storage/v1/object/public/placeholder.jpg',
      item_url: 'https://www.bidrl.com',
      resell_value: 450,
      current_bid: 40,
      ends_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 30 * 60, // ~30 min left
    };
  }

  const { subject, html } = buildEmail(user, lot);
  const sendResult = await sendEmail(toEmail, `[TEST] ${subject}`, html);
  return { ok: sendResult.ok, error: sendResult.error || null, from: FROM_EMAIL };
}

export async function sendFireDealAlerts() {
  console.log('[Alerts] Checking for fire deals ending soon...');
  try {
    const now = Math.floor(Date.now() / 1000);
    const endWindowRaw = now + ENDING_WINDIN_SEC + 2 * 3600; // ends_at carries +2h offset

    // 1) Active lots ending within the window (with a resale value to evaluate)
    const { data: lots } = await supabase
      .from('analyzed_lots')
      .select('lot_number, title, image_url, item_url, resell_value, current_bid, ends_at')
      .eq('affiliate_id', ROCKLIN_AFFILIATE)
      .gt('ends_at', now + 2 * 3600)        // not already ended
      .lt('ends_at', endWindowRaw)          // ending within ~1 hour
      .gt('resell_value', 0);

    if (!lots || lots.length === 0) {
      console.log('[Alerts] No lots ending within the window.');
      return;
    }

    // 2) Pro users who opted into fire alerts, with their synced settings
    const { data: users } = await supabase
      .from('users')
      .select('id, email, is_pro, email_fire_alerts, user_settings(target_margin, buyers_premium, fire_threshold)')
      .eq('is_pro', true)
      .eq('email_fire_alerts', true);

    if (!users || users.length === 0) {
      console.log('[Alerts] No opted-in Pro users.');
      return;
    }

    let sent = 0;
    for (const user of users) {
      // settings: use synced values or fall back to app defaults
      const s = user.user_settings || {};
      const tm = s.target_margin ?? 30;
      const bp = s.buyers_premium ?? 15;
      const ft = s.fire_threshold ?? 50;

      for (const lot of lots) {
        // Flag using the EXACT app logic
        if (!isFireDeal(lot.resell_value, parseFloat(lot.current_bid) || 0, tm, bp, ft)) continue;

        // Dedup: skip if this user was already alerted for this lot
        const { data: already } = await supabase
          .from('deal_alerts_sent')
          .select('id')
          .eq('user_id', user.id)
          .eq('lot_number', lot.lot_number)
          .maybeSingle();
        if (already) continue;

        const { subject, html } = buildEmail({ ...user, target_margin: tm, buyers_premium: bp }, lot);
        const sendResult = await sendEmail(user.email, subject, html);
        if (sendResult.ok) {
          await supabase.from('deal_alerts_sent').insert({
            user_id: user.id, lot_number: lot.lot_number, sent_at: new Date().toISOString(),
          });
          sent++;
        }
      }
    }
    console.log(`[Alerts] Sent ${sent} fire-deal alert(s).`);
  } catch (e) {
    console.error('[Alerts] sendFireDealAlerts error:', e.message);
  }
}
