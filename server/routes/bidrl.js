import fetch from 'node-fetch';

const BIDRL_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.bidrl.com',
  'Referer': 'https://www.bidrl.com/',
};

// GET /bidrl/affiliates
export async function getAffiliates(req, res) {
  try {
    const response = await fetch('https://www.bidrl.com/api/affiliateslist', {
      method: 'POST',
      headers: BIDRL_HEADERS,
    });
    const data = await response.json();

    // Get distinct affiliate IDs with active items in DB
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: supported, error } = await supabase
      .from('analyzed_lots')
      .select('affiliate_id')
      .gt('ends_at', Math.floor(Date.now() / 1000))
      .limit(1000);

    const supportedIds = new Set((supported || []).map(r => String(r.affiliate_id)));

    // If DB query fails, return affiliates without supported flag rather than empty list
    if (error) {
      console.error('Affiliates supported check error:', error.message);
      return res.json(data);
    }

    const enriched = (Array.isArray(data) ? data : [])
      .filter(aff => aff.value && String(aff.value) !== '0')
      .map(aff => ({
        ...aff,
        supported: supportedIds.has(String(aff.value)),
      }));

    res.json(enriched);
  } catch (err) {
    console.error('Affiliates proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
}

// GET /bidrl/items?affiliateId=75&page=1
export async function getItems(req, res) {
  try {
    const { affiliateId, page = 1 } = req.query;
    if (!affiliateId) return res.status(400).json({ error: 'affiliateId required' });

    let body = `filters%5Baffiliates%5D=${affiliateId}`;
    if (page > 1) body += `&filters%5Bpage%5D=${page}`;

    const response = await fetch('https://www.bidrl.com/api/getitems', {
      method: 'POST',
      headers: BIDRL_HEADERS,
      body,
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Items proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
}

// GET /api/lot-detail/:lotNumber — full item view: our BidMax analysis (resale
// gated to Pro) merged with the LIVE BidRL item (all images, description, bid
// count) fetched by keyword search. Powers the in-app item screen + notification
// deep-links. No schema change: images/description come fresh from BidRL.
export async function getLotDetail(req, res) {
  try {
    const { lotNumber } = req.params;
    if (!lotNumber) return res.status(400).json({ error: 'lotNumber required' });

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Pro gate for the resale value (same policy as the items list).
    let isPro = false;
    try {
      const token = req.headers.authorization?.replace('Bearer ', '') || req.query.sessionToken;
      if (token) {
        const { validateSession } = await import('./auth.js');
        const user = await validateSession(token);
        isPro = user?.is_pro || false;
      }
    } catch {}

    // BidMax side + live bid/end from our DB (kept fresh by the Pusher listener).
    const { data: row } = await supabase
      .from('analyzed_lots')
      .select('title, item_url, image_url, resell_value, condition, current_bid, minimum_bid, ends_at, high_bidder')
      .eq('lot_number', lotNumber)
      .maybeSingle();

    // Live BidRL item — one item via keyword search (returns all images + description).
    let bidrl = null;
    try {
      const body = new URLSearchParams();
      body.set('filters[keyword]', lotNumber);
      const r = await fetch('https://www.bidrl.com/api/getitems', {
        method: 'POST', headers: BIDRL_HEADERS, body: body.toString(),
      });
      const d = await r.json();
      const items = d.items || [];
      bidrl = items.find(i => i.lot_number === lotNumber) || items[0] || null;
    } catch (e) {
      console.error('[LotDetail] BidRL fetch error:', e.message);
    }

    if (!row && !bidrl) return res.status(404).json({ error: 'Not found' });

    // Images: prefer BidRL's full array; fall back to our stored thumbnail.
    const images = (bidrl?.images?.length)
      ? bidrl.images
          .map(im => ({ thumb: im.thumb_url || im.image_url, full: im.image_url || im.thumb_url }))
          .filter(x => x.full)
      : (row?.image_url ? [{ thumb: row.image_url, full: row.image_url }] : []);

    const stripHtml = (s) => (s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();

    return res.json({
      lotNumber,
      title: bidrl?.title || row?.title || '',
      itemUrl: bidrl?.item_url || row?.item_url || '',
      category: bidrl?.category_name || '',
      images,
      description: stripHtml(bidrl?.description).slice(0, 1200),
      currentBid: parseFloat(row?.current_bid ?? bidrl?.current_bid) || 0,
      minimumBid: parseFloat(row?.minimum_bid ?? bidrl?.minimum_bid) || 0,
      bidCount: parseInt(bidrl?.bid_count) || 0,
      endsAt: row?.ends_at || (bidrl?.end_time ? parseInt(bidrl.end_time) + 7200 : 0),
      highBidder: row?.high_bidder || bidrl?.winner || bidrl?.high_bidder || null,
      buyerPremium: parseFloat(bidrl?.buyer_premium) || 15,
      condition: row?.condition || null,
      resellValue: isPro ? (row?.resell_value ?? null) : null,
    });
  } catch (err) {
    console.error('[LotDetail] error:', err.message);
    res.status(500).json({ error: 'Failed to load lot' });
  }
}

// GET /bidrl/bid/:lotNumber — live current bid for a single item
export async function getLiveBid(req, res) {
  try {
    const { lotNumber } = req.params;
    if (!lotNumber) return res.status(400).json({ error: 'lotNumber required' });

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: dbItem } = await supabase
      .from('analyzed_lots')
      .select('current_bid, minimum_bid, ends_at, high_bidder')
      .eq('lot_number', lotNumber)
      .single();

    if (!dbItem) return res.status(404).json({ error: 'Item not found' });

    // Stored ends_at IS the true epoch end (verified against BidRL's displayed
    // close times — the raw feed values get +7200 applied at ingestion). The old
    // extra -7200 here made secondsRemaining 2h short. The client should still
    // tick this down between polls; it's fresh as of THIS request.
    const secondsRemaining = dbItem.ends_at
      ? Math.max(0, dbItem.ends_at - Math.floor(Date.now() / 1000))
      : null;

    return res.json({
      lotNumber,
      currentBid: parseFloat(dbItem.current_bid) || 0,
      minimumBid: parseFloat(dbItem.minimum_bid) || 0,
      bidCount: 0,
      endsAt: dbItem.ends_at || 0,
      secondsRemaining,
      highBidder: dbItem.high_bidder || null,
    });
  } catch (err) {
    console.error('Live bid proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch live bid' });
  }
}
