import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pusher } = require('pusher-js/node');
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BIDRL_PUSHER_KEY = '8a9aa527c32e9ca02b0f';
const BIDRL_PUSHER_CLUSTER = 'us3';

let pusherClient = null;
let subscribedChannels = new Map(); // itemId -> channel
let syncInterval = null;
let started = false;
let syncing = false;

const sseClients = new Set();

export function registerSseClient(res) {
  sseClients.add(res);
}

export function unregisterSseClient(res) {
  sseClients.delete(res);
}

async function handleBidEvent(lotNumber, data, affiliateId) {
  try {
    const item = typeof data === 'string' ? JSON.parse(data) : data;
    const bidData = item.item || item;

    const newBid = parseFloat(bidData.current_bid) || 0;
    const newMin = parseFloat(bidData.minimum_bid) || 0;
    const endsAt = bidData.end_time ? parseInt(bidData.end_time) + (2 * 3600) : undefined;

    // Bids only ever increase. Guard the bid update to only RAISE the value so
    // out-of-order event delivery (possible after a reconnect) can't write a
    // stale lower bid over a newer one. Consistent with the scan's bid-refresh.
    if (newBid > 0) {
      // A bid event means the high bidder just changed. Pusher exposes the
      // readable handle as `highbidder_username` (note: `high_bidder` here is the
      // numeric user ID, not the name). Write it alongside the raised bid, guarded
      // so a stale lower bid never overwrites.
      const winnerName = bidData.highbidder_username || null;
      const bidUpdate = { current_bid: newBid, minimum_bid: newMin };
      if (winnerName) bidUpdate.high_bidder = winnerName;
      const { error } = await supabase
        .from('analyzed_lots')
        .update(bidUpdate)
        .eq('lot_number', lotNumber)
        .lt('current_bid', newBid);
      if (!error) console.log(`[Pusher] Bid update: ${lotNumber} -> $${newBid}${winnerName ? ` (winner: ${winnerName})` : ''}`);

      // Roster this bidder for subscriber-funnel sizing. Every distinct
      // highbidder_username we ever see at a location accumulates in
      // location_bidders (de-duped); times_led counts how often they took the
      // lead — an engagement signal. Fire-and-forget so it never delays the bid
      // path. NOTE: this is a FLOOR on the crowd — we only see bidders who led a
      // lot, never pure watchers or under-bidders.
      if (winnerName && affiliateId != null) {
        supabase.rpc('record_location_bidder', {
          p_affiliate_id: String(affiliateId),
          p_username: winnerName,
        }).then(({ error: rpcErr }) => {
          if (rpcErr) console.error('[Pusher] record_location_bidder:', rpcErr.message);
        });
      }
    }

    // End time can change (auction extensions) — safe to refresh unconditionally.
    if (endsAt !== undefined) {
      await supabase
        .from('analyzed_lots')
        .update({ ends_at: endsAt })
        .eq('lot_number', lotNumber);
    }

    // Push to any connected SSE clients so the app updates without polling.
    if (sseClients.size) {
      const broadcast = { lotNumber };
      if (newBid > 0) { broadcast.currentBid = newBid; broadcast.highBidder = winnerName || null; }
      if (endsAt !== undefined) broadcast.endsAt = endsAt;
      if (broadcast.currentBid !== undefined || broadcast.endsAt !== undefined) {
        const payload = `data: ${JSON.stringify(broadcast)}\n\n`;
        for (const client of sseClients) {
          try { client.write(payload); } catch { sseClients.delete(client); }
        }
      }
    }
  } catch (e) {
    console.error('[Pusher] handleBidEvent error:', e.message);
  }
}

function subscribeToItem(itemId, lotNumber, affiliateId) {
  if (!pusherClient || subscribedChannels.has(itemId)) return;
  const channelName = `www.bidrl.com-item-${itemId}`;
  const channel = pusherClient.subscribe(channelName);
  channel.bind('bid', (data) => handleBidEvent(lotNumber, data, affiliateId));
  subscribedChannels.set(itemId, channel);
}

function unsubscribeFromItem(itemId) {
  if (!pusherClient || !subscribedChannels.has(itemId)) return;
  pusherClient.unsubscribe(`www.bidrl.com-item-${itemId}`);
  subscribedChannels.delete(itemId);
}

async function syncSubscriptions() {
  if (!pusherClient || pusherClient.connection.state !== 'connected') return;
  if (syncing) return; // prevent overlapping syncs from stacking
  syncing = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const { data: activeItems } = await supabase
      .from('analyzed_lots')
      .select('item_id, lot_number, ends_at, affiliate_id')
      .not('item_id', 'is', null)
      .gt('ends_at', now);

    const wanted = (activeItems || []);
    const activeItemIds = new Set(wanted.map(i => i.item_id));

    // Unsubscribe from items no longer active
    for (const [itemId] of subscribedChannels) {
      if (!activeItemIds.has(itemId)) unsubscribeFromItem(itemId);
    }
    // Subscribe to all active items (no cap — matches prior working behavior)
    for (const item of wanted) {
      if (!subscribedChannels.has(item.item_id)) {
        subscribeToItem(item.item_id, item.lot_number, item.affiliate_id);
      }
    }
    console.log(`[Pusher] Subscribed to ${subscribedChannels.size} item channels`);
  } catch (e) {
    console.error('[Pusher] syncSubscriptions error:', e.message);
  } finally {
    syncing = false;
  }
}

export async function startPusherListener() {
  // Guard: create the client, handlers, and interval exactly once per process.
  // Let pusher-js manage its own reconnection — do NOT tear down/rebuild on
  // disconnect, which is what caused the old reconnect loop.
  if (started) {
    console.log('[Pusher] Listener already started — ignoring duplicate call');
    return;
  }
  started = true;

  pusherClient = new Pusher(BIDRL_PUSHER_KEY, {
    cluster: BIDRL_PUSHER_CLUSTER,
    forceTLS: true,
  });

  pusherClient.connection.bind('connected', () => {
    console.log('[Pusher] Connected to BidRL');
    syncSubscriptions();
  });

  pusherClient.connection.bind('disconnected', () => {
    console.log('[Pusher] Disconnected — pusher-js will auto-reconnect');
  });

  pusherClient.connection.bind('error', (err) => {
    const msg = err?.error?.data?.message || err?.error?.message || 'unknown';
    console.error('[Pusher] Connection error:', msg);
  });

  pusherClient.connection.bind('state_change', (states) => {
    console.log(`[Pusher] State: ${states.previous} -> ${states.current}`);
  });

  // Single re-sync interval, created exactly once — reconciles new/ended items.
  if (!syncInterval) {
    syncInterval = setInterval(syncSubscriptions, 15 * 60 * 1000);
  }
}

// GET /api/location-bidders?affiliateId=75[&days=30][&list=1]
// Subscriber-funnel sizing: how many distinct bidders we've observed taking the
// lead at a location. `days` limits to bidders active in the last N days (omit
// for all-time). `list=1` also returns the roster (top by times_led).
// Reminder: this is a FLOOR — pure watchers and under-bidders are invisible to us.
export async function getLocationBidders(req, res) {
  // Admin-gated: returns BidRL usernames, so keep it out of public reach.
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) return res.status(404).json({ error: 'Not found' });
  const affiliateId = req.query.affiliateId;
  if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });
  const days = Math.max(0, parseInt(req.query.days) || 0);
  const wantList = req.query.list === '1' || req.query.list === 'true';
  try {
    let query = supabase
      .from('location_bidders')
      .select('username, first_seen, last_seen, times_led', { count: 'exact' })
      .eq('affiliate_id', String(affiliateId))
      .order('times_led', { ascending: false });
    if (days > 0) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      query = query.gte('last_seen', since);
    }
    // We only need the exact count unless the caller wants the roster.
    query = query.range(0, wantList ? 999 : 0);
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({
      affiliateId: String(affiliateId),
      windowDays: days || null,
      uniqueBidders: count || 0,
      ...(wantList ? { bidders: data || [] } : {}),
    });
  } catch (e) {
    console.error('[LocationBidders] error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
