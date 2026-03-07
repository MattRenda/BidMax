import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { analyzeLot, analyzeBatch } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '50kb' }));

// Serve landing page explicitly
app.get('/', (req, res) => {
  const indexPath = join(__dirname, 'public', 'index.html');
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ error: 'index.html not found', __dirname, files: existsSync(join(__dirname, 'public')) ? readdirSync(join(__dirname, 'public')) : 'no public dir' });
  }
});

app.get('/privacy-policy.html', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'privacy-policy.html'));
});

// Static files for everything else
app.use(express.static(join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
app.use('/api/', limiter);

app.post('/api/analyze', analyzeLot);
app.post('/api/analyze-batch', analyzeBatch);
app.post('/api/comps', getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true, __dirname, publicExists: existsSync(join(__dirname, 'public')) }));

app.listen(PORT, () => console.log(`BidMax server running on port ${PORT}`));
