import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { analyzeBatch } from './routes/analyze.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '500kb' })); // large — 200 items with images

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true });
app.use('/api/', limiter);

app.post('/api/analyze-batch', analyzeBatch);
app.get('/api/health', (_, res) => res.json({ ok: true, version: '2.0.0' }));

app.listen(PORT, () => console.log(`BidMax server v2 running on port ${PORT}`));
