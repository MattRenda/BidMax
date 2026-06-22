import { SERVER_URL } from './config';
import { getDeviceId, Usage } from './auth';

export interface Affiliate {
  id: string;
  name: string;
  value: string;
  active: boolean; // false = listed by BidRL but not yet supported (requestable)
}

// Unified card model. `saleValue` is the server's pre-analyzed resale estimate;
// max bid / profit are derived from it at render time so they track the live ROI
// setting. For free users it may be hidden in the UI until they reveal it.
export interface Listing {
  lotId: string;
  title: string;
  itemUrl: string;
  imageUrl: string | null;
  currentBid: number;
  minimumBid: number;
  bidCount: number;
  endTime: number;        // Unix seconds (multiply by 1000 for JS Date)
  buyersPremium: number;
  auctionTitle: string;
  saleValue: number | null;
  highBidder: string | null;   // current high bidder's BidRL username, null if no bids
}

export interface ScanSettings {
  targetMargin: number;
  buyersPremium: number;
}

export interface ItemsPage {
  items: Listing[];
  totalPages: number;
  total: number;
}

export class LimitReachedError extends Error {
  code = 'LIMIT_REACHED' as const;
  used: number;
  limit: number;
  constructor(message: string, used: number, limit: number) {
    super(message);
    this.used = used;
    this.limit = limit;
  }
}

export function calcBid(saleValue: number, targetMargin = 30, buyersPremium = 15) {
  const sale = Number.isFinite(saleValue) ? saleValue : 0;
  const roi = (Number.isFinite(targetMargin) ? targetMargin : 30) / 100;
  const premium = 1 + (Number.isFinite(buyersPremium) ? buyersPremium : 15) / 100;
  const maxBid = Math.max(0, Math.floor(sale / premium / (1 + roi)));
  const totalCost = Math.round(maxBid * premium);
  const expectedProfit = Math.round(sale - totalCost);
  return { maxBid, totalCost, expectedProfit };
}

// A lot is worth bidding on only if the current bid still leaves room under the
// max bid your ROI allows (e.g. a $10 item already bid to $12 is not worth it).
export function isWorthBidding(deal: { maxBid: number; currentBid: number }): boolean {
  return deal.maxBid > 0 && deal.currentBid < deal.maxBid;
}

function num(v: any): number {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

// BidRL titles come HTML-encoded (e.g. 6&#39; x 9&#39; → 6' x 9'). RN has no
// DOM to decode them, so handle numeric + the common named entities ourselves.
function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// fetch with a hard timeout so a hung endpoint surfaces an error instead of
// leaving the UI stuck on a loading spinner forever.
async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 25000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Request timed out — the server took too long to respond.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Maps a pre-analyzed DB row (shared by /api/items and /api/top-picks) into a
// Listing. Both use: lot_number, title, item_url, image_url, current_bid,
// ends_at (Unix seconds), resell_value. buyer_premium may be absent → use setting.
function toAnalyzedListing(row: any, settings: ScanSettings): Listing | null {
  const lotId = String(row.lot_number ?? '');
  if (!lotId) return null;

  // Ignore "bin"/placeholder listings that aren't real lots — they carry an
  // absurd far-future close time (~3476d out) instead of a real auction end.
  // Keep items with no end time (0): those are just missing a value, not bins.
  const endTime = num(row.ends_at);
  if (endTime && endTime > Date.now() / 1000 + 60 * 86400) return null;

  // resell_value is null for free users (server-gated) — keep the item anyway
  // (saleValue null → card shows the Reveal button); Pro users get the number.
  const rv = row.resell_value;
  const saleValue = rv == null || rv === '' ? null : num(rv);
  return {
    lotId,
    title: decodeEntities(row.title ?? ''),
    itemUrl: row.item_url ?? '',
    imageUrl: row.image_url ?? null,
    currentBid: num(row.current_bid),
    minimumBid: num(row.minimum_bid),
    bidCount: num(row.bid_count),
    endTime,
    buyersPremium: num(row.buyer_premium) || settings.buyersPremium,
    auctionTitle: decodeEntities(row.auction_title ?? ''),
    saleValue,
    highBidder: row.high_bidder ?? null,
  };
}

export async function fetchAffiliates(): Promise<Affiliate[]> {
  const res = await fetch(`${SERVER_URL}/bidrl/affiliates`, { method: 'GET' });
  const data = await res.json();
  // Tolerate a bare array or a wrapped object so a server shape change doesn't
  // wipe the list.
  const list: any[] = Array.isArray(data)
    ? data
    : (data?.affiliates ?? data?.locations ?? data?.data ?? data?.items ?? []);

  const rows = list.filter(a => {
    if (!a || !a.name) return false;
    const n = String(a.name).trim().toLowerCase();
    return n !== 'all' && n !== 'all locations'; // drop the "All" meta-entry
  });

  // Prefer a server "supported" flag (supported/active/enabled/hasData). If the
  // server doesn't send one yet, fall back to the value heuristic so locations
  // stay selectable instead of all showing as unsupported.
  const flag = (a: any) => a.supported ?? a.active ?? a.enabled ?? a.hasData;
  const hasFlag = rows.some(a => flag(a) != null);

  return rows
    .map(a => ({
      id: String(a.id),
      name: String(a.name).trim(),
      value: String(a.value),
      active: hasFlag ? !!flag(a) : (!!a.value && String(a.value) !== '0'),
    }))
    // Supported locations first, then alphabetical.
    .sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
}

// Register demand for a location the app doesn't support yet. Sends the session
// token so the server can attach user_id, and affiliateName so it's stored.
export async function requestLocation(aff: Affiliate, sessionToken?: string): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/request-location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify({
        affiliateId: aff.id,
        affiliateName: aff.name,
        name: aff.name,
        sessionToken: sessionToken ?? null,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// All pre-analyzed items for a location, paginated, sorted server-side by resell
// value. Response: { items: [...], total_pages, total }.
export async function fetchItems(
  affiliateId: string,
  page: number,
  settings: ScanSettings,
  auth?: { sessionToken?: string; all?: boolean },
): Promise<ItemsPage> {
  // all=true returns every lot for the location in one request (server-side),
  // so the client doesn't have to page through dozens of slow requests.
  const qs = auth?.all
    ? `affiliateId=${encodeURIComponent(affiliateId)}&all=true`
    : `affiliateId=${encodeURIComponent(affiliateId)}&page=${page}`;
  const res = await fetchWithTimeout(`${SERVER_URL}/api/items?${qs}`, {
    headers: auth?.sessionToken ? { Authorization: `Bearer ${auth.sessionToken}` } : undefined,
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);

  const data = await res.json();
  const list: any[] = Array.isArray(data) ? data : (data.items ?? data.picks ?? []);
  const items = list
    .map(r => toAnalyzedListing(r, settings))
    .filter((d): d is Listing => d !== null);

  return {
    items,
    totalPages: num(data.total_pages ?? data.totalPages) || 1,
    total: num(data.total ?? data.total_items ?? data.totalItems ?? data.count) || 0,
  };
}

// Pro pre-analyzed top picks (top 10 by resell value).
export async function fetchTopPicks(
  affiliateId: string,
  settings: ScanSettings,
  auth?: { sessionToken?: string },
): Promise<Listing[]> {
  const res = await fetchWithTimeout(`${SERVER_URL}/api/top-picks?affiliateId=${encodeURIComponent(affiliateId)}`, {
    headers: auth?.sessionToken ? { Authorization: `Bearer ${auth.sessionToken}` } : undefined,
  });
  if (!res.ok) throw new Error(`Server error ${res.status}`);

  const data = await res.json();
  const list: any[] = Array.isArray(data) ? data : (data.picks ?? []);

  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const row of list) {
    const listing = toAnalyzedListing(row, settings);
    if (!listing) continue;
    const key = listing.title.toLowerCase().trim();
    if (key && seen.has(key)) continue;
    seen.add(key);
    out.push(listing);
  }
  return out.sort((a, b) => (b.saleValue ?? 0) - (a.saleValue ?? 0));
}

// On-demand single-lot analysis used by the FREE reveal flow. Returns the resale
// value and counts against the daily limit server-side. Throws LimitReachedError
// on HTTP 402.
export async function analyzeItem(
  item: Listing,
  settings: ScanSettings,
  sessionToken?: string,
): Promise<{ saleValue: number; usage: Usage | null }> {
  const deviceId = await getDeviceId();
  const res = await fetchWithTimeout(`${SERVER_URL}/api/analyze-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lots: [{
        lotId: item.lotId,
        title: item.title,
        imageUrl: item.imageUrl,
        description: `${item.title}\nLot #${item.lotId}\nCurrent bid: $${item.currentBid}\nMinimum bid: $${item.minimumBid}`,
      }],
      settings,
      sessionToken: sessionToken ?? null,
      deviceId,
      // Return the lot's already-stored resell_value (the same number Pro sees),
      // gated by the daily counter — don't re-run the AI, which would yield a
      // different estimate for the same item. Free and Pro must read one value.
      fromCache: true,
    }),
  }, 45000);

  if (res.status === 402) {
    const body = await res.json().catch(() => ({} as any));
    throw new LimitReachedError(body.error || 'Daily limit reached', num(body.used), num(body.limit));
  }
  if (!res.ok) throw new Error(`Server error ${res.status}`);

  const data = await res.json();
  const result = data.results?.[item.lotId];
  const saleValue = num(result?.totalEstimatedValue);
  if (!saleValue) throw new Error('No analysis returned for this item');

  // Read the authoritative usage the server just applied for this reveal straight
  // from the response headers, so the on-screen counter is exact (instead of a
  // separate /auth/me read that can be keyed differently).
  const usedH = res.headers.get('x-usage-used');
  const limitH = res.headers.get('x-usage-limit');
  const usage: Usage | null = usedH != null
    ? { used: num(usedH), limit: limitH ? num(limitH) : null }
    : null;
  return { saleValue, usage };
}

export interface BidStatus {
  currentBid: number;
  endsAt: number;   // Unix seconds
  bidCount: number;
  highBidder: string | null;  // null if the live endpoint doesn't include it
}

// Live bid + end time for one lot from GET /bidrl/bid/:lotNumber, or null.
export async function fetchBidStatus(lotNumber: string): Promise<BidStatus | null> {
  try {
    const res = await fetch(`${SERVER_URL}/bidrl/bid/${encodeURIComponent(lotNumber)}`);
    if (!res.ok) return null;
    const d = await res.json();
    const currentBid = num(d?.currentBid ?? d?.current_bid);
    const endsAt = num(d?.endsAt ?? d?.ends_at);
    const bidCount = num(d?.bidCount ?? d?.bid_count);
    const highBidder = d?.highBidder ?? d?.high_bidder ?? null;
    if (!currentBid && !endsAt) return null;
    return { currentBid, endsAt, bidCount, highBidder };
  } catch {
    return null;
  }
}
