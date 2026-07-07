import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// One-time boot diagnostic: prove whether the running process can see the key.
console.log('[Alerts] boot: RESEND_API_KEY present?', !!RESEND_API_KEY,
  RESEND_API_KEY ? `(prefix ${RESEND_API_KEY.slice(0, 6)})` : '(MISSING)');
// Show which env var names the process actually has (names only, no values) so
// we can spot scoping issues or name typos/whitespace.
console.log('[Alerts] boot: env names matching resend/email:',
  JSON.stringify(Object.keys(process.env).filter(k => /resend|email/i.test(k))));
// Sender must be on a Resend-VERIFIED domain. bidmaxapp.com (root) is verified
// in Resend, so we default to it. (Earlier this defaulted to send.bidmaxapp.com,
// a subdomain that was NOT verified in Resend, causing sends to fail.)
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'BidMax Alerts <alerts@bidmaxapp.com>';
const APP_LANDING = 'https://bidmaxapp.com';
// Logo shown at the top of alert emails. Set LOGO_URL in Railway to a public
// image URL (e.g. a Supabase storage URL or bidmaxapp.com/logo.png).
const LOGO_URL = process.env.LOGO_URL || 'https://bidmaxapp.com/logo.png';

// Notify when a lot is ending within this window. Spec: ~30 min before end.
const ALERT_WINDOW_SEC = 30 * 60;
const ROCKLIN_AFFILIATE = '75';
// analyzed_lots.ends_at is the TRUE end time (the app's countdown uses it directly).
// The old alert path re-subtracted a 2h offset and fired ~2h early — removed. If
// BidRL ever reintroduces an offset, set this to that offset (e.g. 7200).
const ENDS_AT_OFFSET_SEC = 0;
// Expo push delivery endpoint.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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
    // Log the full picture so we can see exactly what Resend returned.
    console.log('[Alerts] Resend HTTP', res.status, '| response:', JSON.stringify(json),
      '| key prefix:', RESEND_API_KEY ? RESEND_API_KEY.slice(0, 6) : 'NONE',
      '| from:', FROM_EMAIL, '| to:', to);
    if (res.status >= 200 && res.status < 300 && json.id) return { ok: true, id: json.id };
    const detail = json.message || json.name || `HTTP ${res.status}: ${JSON.stringify(json)}`;
    console.error('[Alerts] Resend error:', detail, '| from:', FROM_EMAIL);
    return { ok: false, error: detail };
  } catch (e) {
    console.error('[Alerts] send error:', e.message);
    return { ok: false, error: e.message };
  }
}

function minutesLeft(endsAt) {
  return Math.max(0, Math.round((endsAt - ENDS_AT_OFFSET_SEC - Date.now() / 1000) / 60));
}

function buildEmail(user, lot) {
  const { maxBid, expectedProfit } = calcBid(
    lot.resell_value, user.target_margin, user.buyers_premium
  );
  const mins = minutesLeft(lot.ends_at);
  const unsubUrl = `${APP_LANDING}/unsubscribe?u=${encodeURIComponent(user.id)}`;
  return {
    subject: `🔥 ${lot.title.slice(0, 50)}`,
    html: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
        ${LOGO_URL ? `<div style="text-align:center;padding:8px 0 16px;"><img src="${LOGO_URL}" alt="BidMax" style="height:40px;"></div>` : ''}
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
          <a href="${unsubUrl}">Unsubscribe</a><br>BidMax · ${APP_LANDING}
        </p>
      </div>`,
  };
}

function buildGroupedEmail(user, lots) {
  const unsubUrl = `${APP_LANDING}/unsubscribe?u=${encodeURIComponent(user.id)}`;
  const count = lots.length;
  const subject = count === 1
    ? `🔥 ${lots[0].title.slice(0, 50)}`
    : `🔥 ${count} Fire Deals Ending Soon`;

  const lotSections = lots.map((lot, i) => {
    const { maxBid, expectedProfit } = calcBid(lot.resell_value, user.target_margin, user.buyers_premium);
    const mins = minutesLeft(lot.ends_at);
    const divider = i < lots.length - 1
      ? '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">'
      : '';
    return `
      <p style="font-size:16px;font-weight:600;margin-bottom:8px;">${lot.title}</p>
      ${lot.image_url ? `<img src="${lot.image_url}" alt="" style="width:100%;max-width:480px;border-radius:8px;margin-bottom:8px;">` : ''}
      <table style="width:100%;font-size:15px;margin:8px 0 12px;">
        <tr><td>Estimated resale</td><td style="text-align:right;font-weight:600;">$${Math.round(lot.resell_value)}</td></tr>
        <tr><td>Current bid</td><td style="text-align:right;">$${Math.round(lot.current_bid)}</td></tr>
        <tr><td>Your max bid</td><td style="text-align:right;font-weight:600;">$${maxBid}</td></tr>
        <tr><td>Profit at your max</td><td style="text-align:right;color:#16a34a;font-weight:600;">$${expectedProfit}</td></tr>
        <tr><td>Time left</td><td style="text-align:right;color:#dc2626;font-weight:600;">~${mins} min</td></tr>
      </table>
      <a href="${lot.item_url || APP_LANDING}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View Lot on BidRL</a>
      ${divider}`;
  }).join('');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
      ${LOGO_URL ? `<div style="text-align:center;padding:8px 0 16px;"><img src="${LOGO_URL}" alt="BidMax" style="height:40px;"></div>` : ''}
      <h2 style="color:#dc2626;">🔥 ${count === 1 ? 'Fire Deal Ending Soon' : `${count} Fire Deals Ending Soon`}</h2>
      ${lotSections}
      <p style="font-size:12px;color:#64748b;margin-top:24px;">
        You're receiving this because you enabled Fire Deal alerts in BidMax.
        <a href="${unsubUrl}">Unsubscribe</a><br>BidMax · ${APP_LANDING}
      </p>
    </div>`;

  return { subject, html };
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
  return { ok: sendResult.ok, id: sendResult.id || null, error: sendResult.error || null, from: FROM_EMAIL };
}

// Send Expo push messages (array). Returns true on a 2xx response.
async function sendExpoPush(messages) {
  if (!messages?.length) return false;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages),
    });
    const json = await res.json().catch(() => ({}));
    console.log('[Alerts] Expo push HTTP', res.status, '| response:', JSON.stringify(json).slice(0, 400));
    return res.ok;
  } catch (e) {
    console.error('[Alerts] Expo push error:', e.message);
    return false;
  }
}

// Build ONE grouped push covering all of a user's fire deals — never a burst of
// one-per-lot. Leads with the highest-value lot; the tap payload opens the app.
function buildPushMessage(user, lots) {
  const n = lots.length;
  const top = lots.reduce((a, b) => (b.resell_value > a.resell_value ? b : a), lots[0]);
  const mins = minutesLeft(top.ends_at);
  const title = n === 1 ? '🔥 Fire deal ending soon' : `🔥 ${n} fire deals ending soon`;
  const body = n === 1
    ? `${top.title.slice(0, 90)} · ~${mins} min left`
    : `Top: ${top.title.slice(0, 55)} +${n - 1} more · ending within ~${Math.round(ALERT_WINDOW_SEC / 60)} min`;
  return {
    to: user.expo_push_token,
    sound: 'default',
    priority: 'high',
    badge: n,
    title,
    body,
    data: { type: 'fire_deals', lots: lots.map(l => ({ lot: l.lot_number, url: l.item_url, title: l.title })) },
  };
}

export async function sendFireDealAlerts() {
  console.log('[Alerts] Checking for fire deals ending soon...');
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now + ENDS_AT_OFFSET_SEC;        // ends_at is the true end (offset 0)
    const windowEnd = windowStart + ALERT_WINDOW_SEC;     // ending within ~30 min

    // 1) Active lots ending within the window (with a resale value to evaluate)
    const { data: lots } = await supabase
      .from('analyzed_lots')
      .select('lot_number, title, image_url, item_url, resell_value, current_bid, ends_at')
      .eq('affiliate_id', ROCKLIN_AFFILIATE)
      .gt('ends_at', windowStart)           // not already ended
      .lt('ends_at', windowEnd)             // ending within ~30 min
      .gt('resell_value', 0);

    if (!lots || lots.length === 0) {
      console.log('[Alerts] No lots ending within the window.');
      return;
    }

    // 2) Pro users who opted into fire alerts, with their synced settings
    const { data: users } = await supabase
      .from('users')
      .select('id, email, expo_push_token, is_pro, email_fire_alerts, user_settings(target_margin, buyers_premium, fire_threshold)')
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

      // Collect all qualifying lots for this user before sending anything
      const fireLots = [];
      for (const lot of lots) {
        if (!isFireDeal(lot.resell_value, parseFloat(lot.current_bid) || 0, tm, bp, ft)) continue;

        // Re-fetch ends_at and current_bid so the alert reflects any Pusher
        // soft-close extension that arrived after the bulk query above.
        const { data: fresh } = await supabase
          .from('analyzed_lots')
          .select('ends_at, current_bid')
          .eq('lot_number', lot.lot_number)
          .single();
        const activeLot = fresh ? { ...lot, ends_at: fresh.ends_at, current_bid: fresh.current_bid } : lot;

        // If the lot was extended past the alert window, skip it — the next cron
        // run will alert when it's genuinely ending soon.
        if (activeLot.ends_at >= windowEnd) {
          console.log(`[Alerts] ${lot.lot_number} extended past alert window — skipping`);
          continue;
        }

        // Atomically CLAIM this (user, lot) BEFORE sending. upsert + ignoreDuplicates
        // runs INSERT ... ON CONFLICT DO NOTHING; .select() returns a row ONLY if
        // THIS run inserted it. If empty, another cron run — or a second server
        // instance during a deploy — already claimed it, so skip. This is what kills
        // the DUPLICATE fire-deal pushes (the old select-then-insert had a race that
        // could double-send). Requires a unique index on (user_id, lot_number).
        const { data: claimed } = await supabase
          .from('deal_alerts_sent')
          .upsert(
            { user_id: user.id, lot_number: lot.lot_number, sent_at: new Date().toISOString() },
            { onConflict: 'user_id,lot_number', ignoreDuplicates: true }
          )
          .select('lot_number');
        if (!claimed || claimed.length === 0) continue; // already claimed elsewhere

        fireLots.push(activeLot);
      }

      if (fireLots.length === 0) continue;

      // ONE grouped alert per user. Prefer push (instant, in-app); fall back to
      // email for users who haven't updated to a push-capable build yet.
      const ctx = { ...user, target_margin: tm, buyers_premium: bp };
      let ok = false;
      if (user.expo_push_token) {
        ok = await sendExpoPush([buildPushMessage(ctx, fireLots)]);
      } else {
        const { subject, html } = buildGroupedEmail(ctx, fireLots);
        const r = await sendEmail(user.email, subject, html);
        ok = !!r.ok;
      }
      if (ok) {
        sent++;
      } else {
        // Send failed — RELEASE the claims so the next run retries rather than
        // suppressing the alert forever.
        await supabase
          .from('deal_alerts_sent')
          .delete()
          .eq('user_id', user.id)
          .in('lot_number', fireLots.map(l => l.lot_number));
      }
    }
    console.log(`[Alerts] Sent ${sent} grouped fire-deal alert(s).`);
  } catch (e) {
    console.error('[Alerts] sendFireDealAlerts error:', e.message);
  }
}
