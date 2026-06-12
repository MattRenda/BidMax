import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pusher } = require('pusher-js/node');
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BIDRL_PUSHER_KEY = '8a9aa527c32e9ca02b0f';
const BIDRL_PUSHER_CLUSTER = 'us3';

// Pusher limits channels-per-connection. Subscribe in throttled chunks and
// prioritize items ending soonest so the most relevant lots stay live.
const SUBSCRIBE_CHUNK = 50;          // channels per batch
const SUBSCRIBE_CHUNK_DELAY = 500;   // ms between batches
const MAX_CHANNELS = 400;            // hard ceiling per connection

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function syncSubscriptions() {
  if (!pusherClient || pusherClient.connection.state !== 'connected') return;
  if (syncing) return; // prevent overlapping syncs
  syncing = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    // Order by soonest-ending so the most time-sensitive lots are covered first.
    const { data: activeItems } = await supabase
      .from('analyzed_lots')
      .select('item_id, lot_number, ends_at')
      .not('item_id', 'is', null)
      .gt('ends_at', now)
      .order('ends_at', { ascending: true })
      .limit(MAX_CHANNELS);

    const wanted = (activeItems || []);
    const activeItemIds = new Set(wanted.map(i => i.item_id));

    // Unsubscribe from items no longer active / outside the window
    for (const [itemId] of subscribedChannels) {
      if (!activeItemIds.has(itemId)) unsubscribeFromItem(itemId);
    }

    // Subscribe to new items in throttled chunks to avoid overwhelming Pusher
    const toAdd = wanted.filter(i => !subscribedChannels.has(i.item_id));
    for (let i = 0; i < toAdd.length; i += SUBSCRIBE_CHUNK) {
      if (pusherClient.connection.state !== 'connected') break;
      const chunk = toAdd.slice(i, i + SUBSCRIBE_CHUNK);
      for (const item of chunk) subscribeToItem(item.item_id, item.lot_number);
      if (i + SUBSCRIBE_CHUNK < toAdd.length) await sleep(SUBSCRIBE_CHUNK_DELAY);
    }

    console.log(`[Pusher] Active subscriptions: ${subscribedChannels.size} (wanted ${wanted.length}, added ${toAdd.length})`);
  } catch (e) {
    console.error('[Pusher] syncSubscriptions error:', e.message);
  } finally {
    syncing = false;
  }
}

export async function startPusherListener() {
  if (started) {
    console.log('[Pusher] Listener already started — ignoring duplicate call');
    return;
  }
  started = true;

  pusherClient = new Pusher(BIDRL_PUSHER_KEY, {
    cluster: BIDRL_PUSHER_CLUSTER,
    forceTLS: true,
    activityTimeout: 120000,
    pongTimeout: 30000,
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

  if (!syncInterval) {
    syncInterval = setInterval(syncSubscriptions, 15 * 60 * 1000);
  }
}
