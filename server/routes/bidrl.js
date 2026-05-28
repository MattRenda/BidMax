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
