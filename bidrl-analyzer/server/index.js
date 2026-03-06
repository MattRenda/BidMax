import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { analyzeLot } from './routes/analyze.js';
import { getEbayComps } from './routes/comps.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '10kb' }));

// Rate limiting — 30 requests per minute per IP
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true });
app.use('/api/', limiter);

// Routes
app.post('/api/analyze', analyzeLot);
app.post('/api/comps', getEbayComps);
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
