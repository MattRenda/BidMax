import fetch from 'node-fetch';

export async function getEbayComps(req, res) {
  const { itemName } = req.body;
  if (!itemName) return res.status(400).json({ error: 'Item name required' });

  const appId = process.env.EBAY_APP_ID;

  // If no eBay key configured, return empty gracefully
  if (!appId || appId === 'your_ebay_app_id_here') {
    return res.json({ comps: [], note: 'eBay comps unavailable — add EBAY_APP_ID to enable' });
  }

  try {
    const query = encodeURIComponent(itemName);
    // eBay Finding API — completed (sold) listings
    const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${appId}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${query}` +
      `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
      `&sortOrder=EndTimeSoonest` +
      `&paginationInput.entriesPerPage=5`;

    const response = await fetch(url);
    const data = await response.json();

    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const comps = items.map(item => ({
      title: item.title?.[0] || '',
      price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
      condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
      url: item.viewItemURL?.[0] || '',
    }));

    const prices = comps.map(c => c.price).filter(p => p > 0);
    const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;

    return res.json({ comps, avgPrice });
  } catch (err) {
    console.error('eBay comps error:', err);
    return res.json({ comps: [], note: 'eBay lookup failed' });
  }
}
