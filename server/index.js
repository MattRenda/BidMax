import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { analyzeLot, analyzeBatch } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';
import { getAffiliates, getItems as getBidrlItems, getLiveBid, getLotDetail } from './routes/bidrl.js';
import { mobileAuthStart, mobileAuthCallback } from './routes/auth-mobile.js';
import { runFullScan, getTopPicks, runScanForAffiliate, getLotAnalysis, getItems, requestLocation, getLocationRequests, revealLot, refreshBidsForAffiliate } from './routes/scanner.js';
import { postDailyFind } from './routes/fb-daily-post.js';
import { syncSettings, unsubscribe, savePushToken, getUsageStatus } from './routes/settings-sync.js';
import { sendTestAlert, sendFireDealAlerts } from './routes/deal-alerts.js';
import { handleRevenueCatWebhook } from './routes/revenuecat-webhook.js';
import { startPusherListener, registerSseClient, unregisterSseClient, getLocationBidders } from './routes/pusher-listener.js';
import './cron.js';

dotenv.config();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id'], exposedHeaders: ['X-Usage-Used', 'X-Usage-Limit'] }));
app.options('*', cors());

// Stripe webhook needs raw body — must be before express.json()
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));

app.get('/', (req, res) => {
  const indexPath = join(__dirname, 'public', 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ error: 'index.html not found', files: existsSync(join(__dirname, 'public')) ? readdirSync(join(__dirname, 'public')) : 'no public dir' });
  }
});
app.get('/privacy-policy.html', (req, res) => res.sendFile(join(__dirname, 'public', 'privacy-policy.html')));
app.get('/success.html', (req, res) => res.sendFile(join(__dirname, 'public', 'success.html')));
app.use(express.static(join(__dirname, 'public')));

// Targeted rate limits — only on expensive endpoints
const analyzeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true });
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true });
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 2, standardHeaders: true });

// RevenueCat webhook — no auth middleware, uses its own secret check
app.post('/webhooks/revenuecat', express.json(), handleRevenueCatWebhook);

// BidRL proxy (raw BidRL API — used by extension)
app.get('/bidrl/affiliates', getAffiliates);
app.get('/bidrl/items', getBidrlItems);
app.get('/bidrl/bid/:lotNumber', getLiveBid);
app.get('/api/lot-detail/:lotNumber', getLotDetail);

// Mobile auth
app.get('/auth/google-mobile/start', mobileAuthStart);
app.get('/auth/google-mobile/callback', mobileAuthCallback);

// Scanner DB routes (pre-analyzed, app + extension use these)
app.get('/api/top-picks', getTopPicks);
app.get('/api/items', getItems);
app.post('/api/settings', syncSettings);
app.post('/api/push-token', savePushToken);
app.get('/api/usage', getUsageStatus);
app.get('/unsubscribe', unsubscribe);
app.get('/api/reveal/:lotNumber', revealLot);   // usage-gated reveal for free users
app.get('/api/lot/:lotNumber', getLotAnalysis);  // no usage gate (Pro / internal)
app.post('/api/request-location', requestLocation);
app.get('/api/location-requests', getLocationRequests);
app.get('/api/scan', scanLimiter, runFullScan);
app.get('/api/scan/:affiliateId', scanLimiter, (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  runScanForAffiliate(req.params.affiliateId, limit);
  res.json({ ok: true, limited: limit });
});

// Core analyze routes (on-demand AI analysis — fallback for items not in DB)
app.post('/api/analyze', analyzeLimiter, analyzeLot);
app.post('/api/analyze-batch', analyzeLimiter, analyzeBatch);
app.post('/api/comps', analyzeLimiter, getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true }));

// SSE endpoint — the app connects here to receive real-time bid/end updates
// broadcast from the Pusher listener without polling.
app.get('/api/bid-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // prevent nginx/Railway from buffering
  res.flushHeaders();
  // Heartbeat every 25s keeps Railway's proxy from timing out the idle connection.
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 25000);
  registerSseClient(res);
  req.on('close', () => { clearInterval(heartbeat); unregisterSseClient(res); });
});

// How many distinct bidders we've observed at a location (subscriber-funnel sizing).
app.get('/api/location-bidders', getLocationBidders);

// Auth + billing routes — load lazily so startup errors don't kill the server
async function loadAuthRoutes() {
  try {
    const { googleAuth, getMe, logout, deleteAccount, appleSignIn, createSession, redeemPromo } = await import('./routes/auth.js');
    const { createCheckout, createPortal, handleWebhook } = await import('./routes/billing.js');
    app.post('/auth/google', authLimiter, googleAuth);
    app.post('/auth/apple', authLimiter, appleSignIn);
    app.post('/auth/redeem-promo', redeemPromo);
    app.get('/auth/me', getMe);
    app.post('/auth/logout', logout);
    app.delete('/auth/me', deleteAccount);

    // POST /auth/demo — RETIRED from the public UI (the sign-in button is gone and
    // anonymous browsing covers App Review). Kept, not deleted, but gated behind the
    // admin secret so it is NOT publicly usable: a request without the secret 404s.
    // Re-enable for review with ?secret=<ADMIN_SECRET> (or x-admin-secret header).
    // The demo@bidmaxapp.com user row is intentionally preserved.
    app.post('/auth/demo', async (req, res) => {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) return res.status(404).json({ error: 'Not found' });
      try {
        const DEMO_EMAIL = 'demo@bidmaxapp.com';
        let { data: user } = await supabase
          .from('users').select('*').eq('email', DEMO_EMAIL).maybeSingle();
        if (!user) {
          const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert({ email: DEMO_EMAIL, google_id: 'demo-app-review', is_pro: true })
            .select().single();
          if (insertError) throw insertError;
          user = newUser;
        } else if (!user.is_pro) {
          await supabase.from('users').update({ is_pro: true }).eq('id', user.id);
          user.is_pro = true;
        }
        const sessionToken = await createSession(user.id);
        res.json({ sessionToken });
      } catch (e) {
        console.error('[/auth/demo]', e);
        res.status(500).json({ error: String(e?.stack || e?.message || e) });
      }
    });

    app.post('/billing/checkout', createCheckout);
    app.post('/billing/portal', createPortal);
    app.post('/billing/webhook', handleWebhook);

    // GET /admin/post-now — manually trigger the daily Facebook post.
    // Accepts the admin secret via the x-admin-secret header OR a ?secret=
    // query param (the query param lets you trigger it straight from a browser).
    app.get('/admin/post-now', async (req, res) => {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        await postDailyFind();
        res.json({ ok: true, message: 'Daily find post triggered — check logs and your Page.' });
      } catch (e) {
        console.error('[FB] Manual trigger error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // GET /admin/test-alert?secret=...&to=you@email.com&lot=RA1234
    // Sends a single TEST fire-deal email (bypasses time window + dedup) so you
    // can verify Resend delivery and rendering. `lot` is optional — omit it to
    // send a sample email; include a real lot_number to render that lot.
    app.get('/admin/test-alert', async (req, res) => {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const to = req.query.to;
      if (!to) return res.status(400).json({ error: 'Provide ?to=email address' });
      try {
        const result = await sendTestAlert(to, req.query.lot || null);
        res.status(result.ok ? 200 : 500).json(result);
      } catch (e) {
        console.error('[Alerts] test-alert error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // GET /admin/check-alerts?secret=... — run the real alert check immediately
    // (same logic as the cron: real thresholds, time window, and dedup all apply).
    app.get('/admin/check-alerts', async (req, res) => {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        await sendFireDealAlerts();
        res.json({ ok: true, message: 'Alert check ran — see logs for how many sent.' });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // GET /admin/refresh-bids?secret=...&affiliate=75 — refresh bids/ends/high_bidder
    // for existing lots from BidRL. NO Anthropic analysis = no credit cost. Use this
    // to populate high_bidder on existing rows without a full (expensive) scan.
    app.get('/admin/refresh-bids', async (req, res) => {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const affiliate = req.query.affiliate || '75';
      try {
        await refreshBidsForAffiliate(affiliate);
        res.json({ ok: true, message: `Bid refresh ran for affiliate ${affiliate} — high_bidder/ends/bids updated. No analysis performed.` });
      } catch (e) {
        console.error('[Refresh] manual trigger error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // GET /admin/affiliate-report — monthly payout report
    app.get('/admin/affiliate-report', async (req, res) => {
      const secret = req.headers['x-admin-secret'];
      if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });

      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

      // Count Pro users per referral source and calculate 20% commission
      const { data: users } = await supabase
        .from('users')
        .select('referred_by, is_pro')
        .not('referred_by', 'is', null);

      // Get affiliate names for display
      const { data: affiliateRows } = await supabase
        .from('affiliates')
        .select('id, affiliate_id, name');
      const affiliateMap = {};
      for (const a of affiliateRows || []) affiliateMap[a.id] = a;

      const report = {};
      for (const user of users || []) {
        const key = user.referred_by;
        if (!report[key]) {
          const aff = affiliateMap[key];
          report[key] = {
            ref: key,
            name: aff?.name || key,
            total_users: 0,
            pro_users: 0,
            gross_revenue: 0,
            commission: 0,
          };
        }
        report[key].total_users++;
        if (user.is_pro) {
          report[key].pro_users++;
          report[key].gross_revenue += 9.99;
          report[key].commission += 9.99 * 0.20;
        }
      }

      res.json({
        period: { start: periodStart, end: periodEnd },
        affiliates: Object.values(report).sort((a, b) => b.commission - a.commission),
        total_commission: Object.values(report).reduce((sum, a) => sum + a.commission, 0),
      });
    });

    console.log('Auth + billing routes loaded');
  } catch (err) {
    console.error('Failed to load auth/billing routes:', err.message);
    const errHandler = (_, res) => res.status(503).json({ error: 'Auth service unavailable', detail: err.message });
    app.post('/auth/google', errHandler);
    app.get('/auth/me', errHandler);
    app.post('/billing/checkout', errHandler);
  }
}

app.listen(PORT, async () => {
  console.log(`BidMax server running on port ${PORT}`);
  await loadAuthRoutes();

  // Start real-time bid listener
  startPusherListener().catch(e => console.error('[Pusher] Failed to start:', e.message));
});
