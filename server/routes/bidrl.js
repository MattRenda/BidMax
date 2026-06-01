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
    res.json(data);
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

// GET /bidrl/bid/:lotNumber — live current bid for a single item
export async function getLiveBid(req, res) {
  try {
    const { lotNumber } = req.params;
    if (!lotNumber) return res.status(400).json({ error: 'lotNumber required' });

    // Look up the item in our DB to get auction_id and item_id
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    const { data: dbItem } = await supabase
      .from('analyzed_lots')
      .select('auction_id, item_url, current_bid, ends_at')
      .eq('lot_number', lotNumber)
      .single();

    if (!dbItem) return res.status(404).json({ error: 'Item not found' });

    // Extract item ID from URL: /item/title-ITEMID/
    const itemIdMatch = dbItem.item_url.match(/-(\d+)\/?$/);
    if (!itemIdMatch) {
      // Fall back to DB values
      return res.json({
        lotNumber,
        currentBid: parseFloat(dbItem.current_bid) || 0,
        minimumBid: 0,
        bidCount: 0,
        endsAt: dbItem.ends_at || 0,
      });
    }

    const itemId = itemIdMatch[1];
    
    // Fetch live item data from BidRL
    const response = await fetch(`https://www.bidrl.com/api/getitem/${itemId}`, {
      method: 'GET',
      headers: BIDRL_HEADERS,
    });
    
    if (!response.ok) throw new Error(`BidRL returned ${response.status}`);
    const item = await response.json();

    res.json({
      lotNumber,
      currentBid: parseFloat(item.current_bid) || 0,
      minimumBid: parseFloat(item.minimum_bid) || 0,
      bidCount: parseInt(item.bid_count) || 0,
      endsAt: parseInt(item.ends) || dbItem.ends_at || 0,
    });
  } catch (err) {
    console.error('Live bid proxy error:', err.message);
    res.status(500).json({ error: 'Failed to fetch live bid' });
  }
}
