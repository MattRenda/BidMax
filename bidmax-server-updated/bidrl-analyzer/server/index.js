import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { analyzeLot, analyzeBatch } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

// Rate limiting — 60 req/min (batch counts as 1)
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });
app.use('/api/', limiter);

app.post('/api/analyze', analyzeLot);
app.post('/api/analyze-batch', analyzeBatch);
app.post('/api/comps', getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`BidMax server running on port ${PORT}`));
