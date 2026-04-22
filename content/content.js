// BidMax Content Script v2.0
// Strategy: call BidRL's own /api/getItems endpoint directly,
// get ALL lots at once, batch-analyze, inject badges + Top Picks panel.

(function () {
  'use strict';

  const SERVER_URL = 'https://bidmax-production.up.railway.app';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

  // In-memory cache: itemId → { result, ts }
  const cache = new Map();

  // itemId → DOM card element (populated as cards render)
  const cardRegistry = new Map();

  let settings = null;
  let auctionContext = null; // { affiliateId, auctionId, page }
  let analysisResults = null; // itemId → result
  let topPicksInjected = false;
  let observer = null;

  // ─────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────
  async function init() {
    settings = await getSettings();
    auctionContext = parseUrlContext();
    if (!auctionContext) return; // not an auction page

    startObserver();
    await runAnalysis();
  }

  // ─────────────────────────────────────────────
  // PARSE URL for affiliate/auction context
  // /allitems/affiliates_NzU/live:page_Mg
  // /auction/188519/...
  // ─────────────────────────────────────────────
  function parseUrlContext() {
    const path = window.location.pathname;

    // All-items page: /allitems/affiliates_NzU/...
    const allItemsMatch = path.match(/affiliates_([A-Za-z0-9+/=]+)/);
    if (allItemsMatch) {
      try {
        const affiliateId = atob(allItemsMatch[1]);
        return { type: 'allitems', affiliateId };
      } catch (e) {}
    }

    // Auction page: /auction/188519/...
    const auctionMatch = path.match(/\/auction\/(\d+)/);
    if (auctionMatch) {
      return { type: 'auction', auctionId: auctionMatch[1] };
    }

    return null;
  }

  // ─────────────────────────────────────────────
  // MAIN ANALYSIS FLOW
  // ─────────────────────────────────────────────
  async function runAnalysis() {
    try {
      // 1. Fetch all items from BidRL API
      showStatusBanner('🔍 BidMax: Loading auction items…');
      const items = await fetchAllItems();
      if (!items || items.length === 0) {
        hideStatusBanner();
        return;
      }

      showStatusBanner(`⚡ BidMax: Analyzing ${items.length} lots…`);

      // 2. Check cache — only send uncached items to server
      const toAnalyze = [];
      const cachedResults = {};
      for (const item of items) {
        const cached = cache.get(item.id);
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
          cachedResults[item.id] = cached.result;
        } else {
          toAnalyze.push(item);
        }
      }

      // 3. Batch analyze uncached items
      let freshResults = {};
      if (toAnalyze.length > 0) {
        freshResults = await batchAnalyze(toAnalyze);
        // Store in cache
        for (const [id, result] of Object.entries(freshResults)) {
          cache.set(id, { result, ts: Date.now() });
        }
      }

      // 4. Merge all results
      analysisResults = { ...cachedResults, ...freshResults };

      // 5. Inject Top Picks panel
      injectTopPicksPanel(items, analysisResults);

      // 6. Inject badges on any already-rendered cards
      scanAndBadgeCards();

      hideStatusBanner();
    } catch (err) {
      showStatusBanner(`❌ BidMax error: ${err.message}`, true);
      setTimeout(hideStatusBanner, 5000);
    }
  }

  // ─────────────────────────────────────────────
  // FETCH ALL ITEMS from BidRL API
  // Paginates if needed (perpage=200 max)
  // ─────────────────────────────────────────────
  async function fetchAllItems() {
    const perpage = 200;
    let page = 1;
    let allItems = [];
    let totalPages = 1;

    do {
      const body = new URLSearchParams();
      if (auctionContext.affiliateId) {
        body.set('filters[affiliates]', auctionContext.affiliateId);
      }
      if (auctionContext.auctionId) {
        body.set('filters[auction_id]', auctionContext.auctionId);
      }
      body.set('filters[sortlist]', 'end_time ASC');
      body.set('page', page);
      body.set('perpage', perpage);

      const res = await fetch('https://www.bidrl.com/api/getItems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: body.toString()
      });

      if (!res.ok) throw new Error(`getItems failed: ${res.status}`);
      const data = await res.json();

      allItems = allItems.concat(data.items || []);
      totalPages = data.total_pages || 1;
      page++;
    } while (page <= totalPages);

    return allItems;
  }

  // ─────────────────────────────────────────────
  // BATCH ANALYZE via BidMax server
  // Chunks into groups of 50 to stay under token limits
  // ─────────────────────────────────────────────
  async function batchAnalyze(items) {
    const CHUNK_SIZE = 50;
    const results = {};
    const s = settings || {};

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);

      const payload = {
        lots: chunk.map(item => ({
          id: item.id,
          title: item.title,
          description: item.description || '',
          currentBid: parseFloat(item.current_bid) || 0,
          minBid: parseFloat(item.minimum_bid) || 0,
          buyerPremium: parseFloat(item.buyer_premium) || 13,
          bidCount: parseInt(item.bid_count) || 0,
          imageUrl: item.images?.[0]?.image_url || '',
          category: item.category_name || '',
          endsAt: item.end_time,
        })),
        settings: {
          targetMargin: s.targetMargin || 30,
          fbFee: s.fbFee || 5,
          effortCost: s.effortCost || 10,
        }
      };

      const res = await fetch(`${s.serverUrl || SERVER_URL}/api/analyze-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      const data = await res.json();
      Object.assign(results, data.results || {});
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // TOP PICKS PANEL
  // ─────────────────────────────────────────────
  function injectTopPicksPanel(items, results) {
    if (topPicksInjected) return;

    // Rank by estimated profit, filter to positive only
    const ranked = items
      .map(item => ({ item, result: results[item.id] }))
      .filter(({ result }) => result && result.estimatedProfit > 0)
      .sort((a, b) => b.result.estimatedProfit - a.result.estimatedProfit)
      .slice(0, 8);

    if (ranked.length === 0) return;

    const panel = document.createElement('div');
    panel.id = 'bidmax-top-picks';
    panel.innerHTML = `
      <div class="bm-tp-header">
        <span class="bm-tp-title">🔥 BidMax Top Picks</span>
        <span class="bm-tp-sub">${ranked.length} best opportunities this auction</span>
        <button class="bm-tp-close" onclick="document.getElementById('bidmax-top-picks').remove()">✕</button>
      </div>
      <div class="bm-tp-grid">
        ${ranked.map(({ item, result }, i) => `
          <a class="bm-tp-card ${i === 0 ? 'bm-tp-first' : ''}" href="${item.item_url}" target="_blank">
            <div class="bm-tp-rank">#${i + 1}</div>
            ${item.images?.[0]?.thumb_url ? `<img class="bm-tp-img" src="${item.images[0].thumb_url}" alt="">` : ''}
            <div class="bm-tp-info">
              <div class="bm-tp-name">${truncate(item.title, 55)}</div>
              <div class="bm-tp-stats">
                <span class="bm-tp-profit">+$${result.estimatedProfit}</span>
                <span class="bm-tp-bid">Max bid: $${result.maxBid}</span>
                <span class="bm-tp-resale">Resale: $${result.resaleValue}</span>
              </div>
              <div class="bm-tp-current">Current: $${parseFloat(item.current_bid).toFixed(2)} · ${item.bid_count} bids</div>
            </div>
          </a>
        `).join('')}
      </div>
    `;

    // Insert at top of main content area
    const target = document.querySelector('.items-container, .auction-items, main, #content, .container')
      || document.body;
    target.insertBefore(panel, target.firstChild);
    topPicksInjected = true;
  }

  // ─────────────────────────────────────────────
  // BADGE INJECTION on lot cards
  // ─────────────────────────────────────────────
  function scanAndBadgeCards() {
    if (!analysisResults) return;

    // BidRL lot cards contain a link with the item URL
    // item_url format: /auction/188519/item/title-slug-25334167/
    // We extract the item ID from the URL
    const links = document.querySelectorAll('a[href*="/item/"]');
    const seen = new Set();

    links.forEach(link => {
      const idMatch = link.href.match(/-(\d{7,})\/?\s*$/);
      if (!idMatch) return;
      const itemId = idMatch[1];
      if (seen.has(itemId)) return;
      seen.add(itemId);

      // Walk up to find the card container
      const card = link.closest('.col, .item-col, [class*="item"], [class*="lot"], li')
        || link.parentElement?.parentElement;
      if (!card || card.dataset.bidmax) return;

      const result = analysisResults[itemId];
      if (!result) return;

      card.dataset.bidmax = 'done';
      injectBadge(card, result);
    });
  }

  function injectBadge(card, result) {
    const existing = card.querySelector('.bidmax-badge');
    if (existing) existing.remove();

    const profitColor = result.estimatedProfit >= 15 ? '#22c55e'
      : result.estimatedProfit >= 5 ? '#f59e0b' : '#94a3b8';

    const badge = document.createElement('div');
    badge.className = 'bidmax-badge';
    badge.innerHTML = `
      <div class="bm-row">
        <span class="bm-label">MAX BID</span>
        <span class="bm-label">EST. PROFIT</span>
      </div>
      <div class="bm-row">
        <span class="bm-val bm-bid">$${result.maxBid}</span>
        <span class="bm-val bm-profit" style="color:${profitColor}">$${result.estimatedProfit}</span>
      </div>
      <div class="bm-resale">Est. Resale: $${result.resaleValue}</div>
      ${result.estimatedProfit >= 15 ? '<div class="bm-fire">🔥 Top Pick</div>' : ''}
    `;

    // Insert after the image or at end of card
    const img = card.querySelector('img');
    const insertAfter = img?.parentElement || card;
    insertAfter.after ? insertAfter.after(badge) : card.appendChild(badge);
  }

  // ─────────────────────────────────────────────
  // DOM OBSERVER — badge new cards as they render
  // ─────────────────────────────────────────────
  function startObserver() {
    observer = new MutationObserver(debounce(() => {
      if (analysisResults) scanAndBadgeCards();
    }, 500));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────
  // STATUS BANNER
  // ─────────────────────────────────────────────
  function showStatusBanner(msg, isError = false) {
    let banner = document.getElementById('bidmax-status');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'bidmax-status';
      document.body.appendChild(banner);
    }
    banner.textContent = msg;
    banner.style.background = isError ? '#ef4444' : '#1e293b';
    banner.style.display = 'block';
  }

  function hideStatusBanner() {
    const banner = document.getElementById('bidmax-status');
    if (banner) banner.style.display = 'none';
  }

  // ─────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────
  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get('bidmax_settings', res => {
        resolve(res.bidmax_settings || {});
      });
    });
  }

  // ─────────────────────────────────────────────
  // UTILS
  // ─────────────────────────────────────────────
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // ─────────────────────────────────────────────
  // GO
  // ─────────────────────────────────────────────
  init();

})();
