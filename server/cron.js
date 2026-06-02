import cron from 'node-cron';
import { runScanForAffiliate, refreshBidsForAffiliate } from './routes/scanner.js';

// ── Active affiliates — add new ones here as demand grows ──
// Phase 1: Rocklin only
// Phase 2: Add based on user requests (track in Supabase)
// Phase 3: Tier by demand frequency
const AFFILIATES = [
  { id: '75', name: 'Rocklin' },
  // { id: '39', name: 'Natomas' },      // uncomment to enable
  // { id: '8',  name: 'Elk Grove' },
  // { id: '70', name: 'Folsom' },
  // { id: '73', name: 'Dino Drive - Elk Grove' },
  // { id: '76', name: 'Rancho Cordova' },
  // { id: '3',  name: 'Modesto' },
  // { id: '7',  name: 'Galt' },
  // { id: '57', name: 'West Sacramento' },
  // { id: '38', name: 'Antioch' },
  // { id: '20', name: 'Marysville' },
  // { id: '19', name: 'Turlock' },
  // { id: '22', name: 'Merced' },
  // { id: '35', name: 'Spice Island - Sparks' },
  // { id: '71', name: 'Anderson, CA' },
];

// Full scan with vision analysis 9am-5pm PT (new items added during business hours)
cron.schedule('0 9-17 * * *', async () => {
  console.log(`[Cron] Full scan starting for ${AFFILIATES.length} location(s)`);
  for (const aff of AFFILIATES) {
    console.log(`[Cron] Scanning ${aff.name} (${aff.id})`);
    await runScanForAffiliate(aff.id);
  }
}, { timezone: 'America/Los_Angeles' });

// Lightweight bid refresh 6pm-10pm PT (no new items, just update bids)
cron.schedule('0 18-22 * * *', async () => {
  console.log(`[Cron] Bid refresh starting for ${AFFILIATES.length} location(s)`);
  for (const aff of AFFILIATES) {
    await refreshBidsForAffiliate(aff.id);
  }
}, { timezone: 'America/Los_Angeles' });

console.log(`[Cron] Scheduler active for: ${AFFILIATES.map(a => a.name).join(', ')}`);
console.log('[Cron] Full scan: 9am-5pm PT hourly');
console.log('[Cron] Bid refresh: 6pm-10pm PT hourly');
