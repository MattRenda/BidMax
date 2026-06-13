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

async function handleBidEvent(lotNumber, data) {
  try {
    const item = typeof data === 'string' ? JSON.parse(data) : data;
    const bidData = item.item || item;

    const update = {
      current_bid: parseFloat(bidData.current_bid) || 0,
      minimum_bid: parseFloat(bidData.minimum_bid) || 0,
      ends_at: bidData.end_time ? parseInt(bidData.end_time) + (2 * 3600) : undefined,
    };
    Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

    const { error } = await supabase
      .from('analyzed_lots')
      .update(update)
      .eq('lot_number', lotNumber);

    if (!error) {
      console.log(`[Pusher] Bid update: ${lotNumber} -> $${update.current_bid}`);
    }
  } catch (e) {
    console.error('[Pusher] handleBidEvent error:', e.message);
  }
}

function subscribeToItem(itemId, lotNumber) {
  if (!pusherClient || subscribedChannels.has(itemId)) return;
  const channelName = `www.bidrl.com-item-${itemId}`;
  const channel = pusherClient.subscribe(channelName);
  channel.bind('bid', (data) => handleBidEvent(lotNumber, data));
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
      .select('item_id, lot_number, ends_at')
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
        subscribeToItem(item.item_id, item.lot_number);
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
