import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { analyzeLot, analyzeBatch } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';
import { googleAuth, getMe, logout } from './routes/auth.js';
import { createCheckout, createPortal, handleWebhook } from './routes/billing.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));

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

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
app.use('/api/', limiter);
app.use('/auth/', rateLimit({ windowMs: 60 * 1000, max: 20 }));

app.post('/api/analyze', analyzeLot);
app.post('/api/analyze-batch', analyzeBatch);
app.post('/api/comps', getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.post('/auth/google', googleAuth);
app.get('/auth/me', getMe);
app.post('/auth/logout', logout);

app.post('/billing/checkout', createCheckout);
app.post('/billing/portal', createPortal);
app.post('/billing/webhook', handleWebhook);

app.listen(PORT, () => console.log(`BidMax server running on port ${PORT}`));
