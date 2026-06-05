import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { analyzeLot, analyzeBatch } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';
import { getAffiliates, getItems as getBidrlItems, getLiveBid } from './routes/bidrl.js';
import { mobileAuthStart, mobileAuthCallback } from './routes/auth-mobile.js';
import { runFullScan, getTopPicks, runScanForAffiliate, getLotAnalysis, getItems, requestLocation, getLocationRequests, revealLot } from './routes/scanner.js';
import { handleRevenueCatWebhook } from './routes/revenuecat-webhook.js';
import { startPusherListener } from './routes/pusher-listener.js';
import './cron.js';

dotenv.config();
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

// Mobile auth
app.get('/auth/google-mobile/start', mobileAuthStart);
app.get('/auth/google-mobile/callback', mobileAuthCallback);

// Scanner DB routes (pre-analyzed, app + extension use these)
app.get('/api/top-picks', getTopPicks);
app.get('/api/items', getItems);
app.get('/api/reveal/:lotNumber', revealLot);   // usage-gated reveal for free users
app.get('/api/lot/:lotNumber', getLotAnalysis);  // no usage gate (Pro / internal)
app.post('/api/request-location', requestLocation);
app.get('/api/location-requests', getLocationRequests);
app.get('/api/scan', scanLimiter, runFullScan);
app.get('/api/scan/:affiliateId', scanLimiter, (req, res) => { runScanForAffiliate(req.params.affiliateId); res.json({ ok: true }); });

// Core analyze routes (on-demand AI analysis — fallback for items not in DB)
app.post('/api/analyze', analyzeLimiter, analyzeLot);
app.post('/api/analyze-batch', analyzeLimiter, analyzeBatch);
app.post('/api/comps', analyzeLimiter, getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Auth + billing routes — load lazily so startup errors don't kill the server
async function loadAuthRoutes() {
  try {
    const { googleAuth, getMe, logout, deleteAccount } = await import('./routes/auth.js');
    const { createCheckout, createPortal, handleWebhook } = await import('./routes/billing.js');
    app.post('/auth/google', authLimiter, googleAuth);
    app.get('/auth/me', getMe);
    app.post('/auth/logout', logout);
    app.delete('/auth/me', deleteAccount);
    app.post('/billing/checkout', createCheckout);
    app.post('/billing/portal', createPortal);
    app.post('/billing/webhook', handleWebhook);
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
