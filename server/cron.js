import cron from 'node-cron';
import { runScanForAffiliate, refreshBidsForAffiliate } from './routes/scanner.js';

const ROCKLIN_AFFILIATE_ID = '75';

// Full scan with vision analysis 9am-5pm PT (new items added during business hours)
cron.schedule('0 9-17 * * *', async () => {
  console.log(`[Cron] Full scan starting for Rocklin`);
  await runScanForAffiliate(ROCKLIN_AFFILIATE_ID);
}, { timezone: 'America/Los_Angeles' });

// Lightweight bid refresh 5pm-10pm PT (no new items, just update bids)
cron.schedule('0 18-22 * * *', async () => {
  console.log(`[Cron] Bid refresh starting for Rocklin`);
  await refreshBidsForAffiliate(ROCKLIN_AFFILIATE_ID);
}, { timezone: 'America/Los_Angeles' });

console.log('[Cron] Rocklin scanner scheduled:');
console.log('  Full scan: 9am-5pm PT hourly');
console.log('  Bid refresh: 6pm-10pm PT hourly');
