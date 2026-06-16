import cron from 'node-cron';
import { runScanForAffiliate } from './routes/scanner.js';
import { postDailyFind } from './routes/fb-daily-post.js';

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

// Max NEW items analyzed per scan. Throttles cost so a big backlog (or a huge
// fresh auction) drains gradually across many scans instead of all at once.
// 15 scans/day × 40 = up to 600 new items/day — enough to keep up with normal
// auctions, but a hard ceiling on any single scan's spend.
// Set to null to disable the cap.
const MAX_NEW_ITEMS_PER_SCAN = 40;

// Full scan 7am-8pm PT hourly — catches new auction drops morning and evening
// Bid updates are handled in real-time by Pusher (pusher-listener.js)
cron.schedule('0 7-20 * * *', async () => {
  console.log(`[Cron] Full scan starting for ${AFFILIATES.length} location(s)`);
  for (const aff of AFFILIATES) {
    console.log(`[Cron] Scanning ${aff.name} (${aff.id})`);
    await runScanForAffiliate(aff.id, MAX_NEW_ITEMS_PER_SCAN);
  }
}, { timezone: 'America/Los_Angeles' });

// Midnight scan — catches auctions that go live overnight
cron.schedule('0 0 * * *', async () => {
  console.log(`[Cron] Midnight scan starting for ${AFFILIATES.length} location(s)`);
  for (const aff of AFFILIATES) {
    await runScanForAffiliate(aff.id, MAX_NEW_ITEMS_PER_SCAN);
  }
}, { timezone: 'America/Los_Angeles' });

// Daily "Find of the Day" post to the BidMax Facebook Page at 11am PT —
// a strong midday engagement window. Picks the best active deal from Rocklin
// and posts it with image + caption + link via the Graph API.
cron.schedule('0 11 * * *', async () => {
  console.log('[Cron] Posting daily find to Facebook');
  await postDailyFind();
}, { timezone: 'America/Los_Angeles' });

console.log(`[Cron] Scheduler active for: ${AFFILIATES.map(a => a.name).join(', ')}`);
console.log('[Cron] Full scan: 7am-8pm PT hourly + midnight');
console.log('[Cron] Bid updates: real-time via Pusher');
console.log('[Cron] Daily Facebook find: 11am PT');
