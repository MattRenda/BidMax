import Pusher from 'pusher-js/node';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BIDRL_PUSHER_KEY = '8a9aa527c32e9ca02b0f';
const BIDRL_PUSHER_CLUSTER = 'us3';

let pusherClient = null;
let subscribedChannels = new Map(); // itemId -> channel
let reconnectTimer = null;

function createPusherClient() {
  const client = new Pusher(BIDRL_PUSHER_KEY, {
    cluster: BIDRL_PUSHER_CLUSTER,
    forceTLS: true,
  });

  client.connection.bind('connected', () => {
    console.log('[Pusher] Connected to BidRL');
  });

  client.connection.bind('disconnected', () => {
    console.log('[Pusher] Disconnected — reconnecting in 5s');
    scheduleReconnect();
  });

  client.connection.bind('error', (err) => {
    console.error('[Pusher] Connection error:', err?.error?.data?.message || err);
    scheduleReconnect();
  });

  return client;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log('[Pusher] Reconnecting...');
    startPusherListener();
  }, 5000);
}

async function handleBidEvent(lotNumber, data) {
  try {
    const item = typeof data === 'string' ? JSON.parse(data) : data;
    const bidData = item.item || item;

    const update = {
      current_bid: parseFloat(bidData.current_bid) || 0,
      minimum_bid: parseFloat(bidData.minimum_bid) || 0,
      ends_at: parseInt(bidData.end_time) || undefined,
    };

    // Remove undefined fields
    Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

    const { error } = await supabase
      .from('analyzed_lots')
      .update(update)
      .eq('lot_number', lotNumber);

    if (!error) {
      console.log(`[Pusher] Bid update: ${lotNumber} → $${update.current_bid}`);
    }
  } catch(e) {
    console.error('[Pusher] handleBidEvent error:', e.message);
  }
}

function subscribeToItem(itemId, lotNumber) {
  if (!pusherClient || subscribedChannels.has(itemId)) return;

  const channelName = `www.bidrl.com-item-${itemId}`;
  const channel = pusherClient.subscribe(channelName);

  channel.bind('bid', (data) => {
    handleBidEvent(lotNumber, data);
  });

  subscribedChannels.set(itemId, channel);
}

function unsubscribeFromItem(itemId) {
  if (!pusherClient || !subscribedChannels.has(itemId)) return;
  pusherClient.unsubscribe(`www.bidrl.com-item-${itemId}`);
  subscribedChannels.delete(itemId);
}

async function syncSubscriptions() {
  if (!pusherClient) return;

  try {
    const now = Math.floor(Date.now() / 1000);

    // Get all active items with item_id from DB
    const { data: activeItems } = await supabase
      .from('analyzed_lots')
      .select('item_id, lot_number, ends_at')
      .not('item_id', 'is', null)
      .gt('ends_at', now);

    const activeItemIds = new Set((activeItems || []).map(i => i.item_id));

    // Unsubscribe from ended items
    for (const [itemId] of subscribedChannels) {
      if (!activeItemIds.has(itemId)) {
        unsubscribeFromItem(itemId);
      }
    }

    // Subscribe to new active items
    for (const item of (activeItems || [])) {
      if (!subscribedChannels.has(item.item_id)) {
        subscribeToItem(item.item_id, item.lot_number);
      }
    }

    console.log(`[Pusher] Subscribed to ${subscribedChannels.size} item channels`);
  } catch(e) {
    console.error('[Pusher] syncSubscriptions error:', e.message);
  }
}

export async function startPusherListener() {
  // Clean up existing connection
  if (pusherClient) {
    pusherClient.disconnect();
    subscribedChannels.clear();
  }

  pusherClient = createPusherClient();

  // Wait for connection then sync subscriptions
  pusherClient.connection.bind('connected', async () => {
    await syncSubscriptions();

    // Re-sync subscriptions every 15 minutes (new items from scanner)
    setInterval(syncSubscriptions, 15 * 60 * 1000);
  });
}
