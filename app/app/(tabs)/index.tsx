import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, SafeAreaView, Modal, ScrollView, Alert,
  Platform, StatusBar, RefreshControl, Pressable, Dimensions, TextInput, Image, Switch
} from 'react-native';

const SCREEN_H = Dimensions.get('window').height;

// SSE stream (/api/bid-stream) delivers real-time bid/end updates pushed from
// the server's BidRL Pusher listener. The 1s tick drives local countdowns.
const LIVE_BIDS_ENABLED = true;
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../hooks/useTheme';
import { Palette } from '../../services/theme';
import { useAuth } from '../../hooks/useAuth';
import { useSettings } from '../../hooks/useSettings';
import { fetchUsage, Usage } from '../../services/auth';
import { track } from '../../services/analytics';
import { SERVER_URL } from '../../services/config';
import { DealCard } from '../../components/DealCard';
import { PromoModal } from '../../components/PromoModal';
import {
  fetchAffiliates, fetchItems, fetchBidStatus, requestLocation,
  analyzeItem, calcBid, LimitReachedError, Affiliate, Listing, BidStatus,
} from '../../services/api';

type SortMode = 'ending' | 'ending_late' | 'bid_high' | 'bid_low' | 'az';

// Sort options for the Filters sheet: [key, label, line icon].
const SORT_ROWS: readonly [SortMode, string, any][] = [
  ['ending', 'Ending soonest', require('../../assets/ic-clock.png')],
  ['ending_late', 'Ending latest', require('../../assets/ic-clock-late.png')],
  ['bid_high', 'Bid: high to low', require('../../assets/ic-sort-desc.png')],
  ['bid_low', 'Bid: low to high', require('../../assets/ic-sort-asc.png')],
  ['az', 'A–Z', require('../../assets/ic-az.png')],
];
type ViewMode = 'all' | 'picks';

export default function DealsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { user, sessionToken } = useAuth();
  const { settings, save } = useSettings();
  const isPro = !!user?.isPro;

  const [view, setView] = useState<ViewMode>('all');
  const [items, setItems] = useState<Listing[]>([]);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('ending');
  const [scannedAll, setScannedAll] = useState(false);
  const [analyzing, setAnalyzing] = useState<string[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Free users: lotId → revealed resale value (server value stays hidden until then).
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  // Live bid/end data for currently-visible lots, keyed by lotId.
  const [liveBids, setLiveBids] = useState<Map<string, BidStatus>>(new Map());
  const [now, setNow] = useState(Date.now());
  const visibleIdsRef = React.useRef<string[]>([]);
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [requested, setRequested] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showPromo, setShowPromo] = useState(false);

  // Offer the promo code once, after a free user signs in (before they dig into
  // the app). Pro users skip it; the "seen" flag keeps it one-time.
  const promoChecked = React.useRef(false);
  React.useEffect(() => {
    if (promoChecked.current || !user || isPro) return;
    promoChecked.current = true;
    AsyncStorage.getItem('bidmax_promo_seen').then(v => { if (!v) setShowPromo(true); });
  }, [user, isPro]);
  const closePromo = () => {
    setShowPromo(false);
    AsyncStorage.setItem('bidmax_promo_seen', '1').catch(() => {});
  };

  const loadAffiliates = useCallback(async () => {
    try { setAffiliates(await fetchAffiliates()); } catch {}
  }, []);

  const refreshUsage = useCallback(async () => {
    if (!sessionToken) return;
    const u = await fetchUsage(sessionToken);
    if (u) setUsage(u);
  }, [sessionToken]);

  React.useEffect(() => { loadAffiliates(); }, []);
  React.useEffect(() => { refreshUsage(); }, [refreshUsage]);

  // Persist revealed analyses so they stay unlocked across re-scans / restarts
  // (no re-clicking a lot you've already analyzed).
  const revealedLoaded = React.useRef(false);
  React.useEffect(() => {
    AsyncStorage.getItem('bidmax_revealed').then(raw => {
      if (raw) { try { setRevealed(JSON.parse(raw)); } catch {} }
      revealedLoaded.current = true;
    });
  }, []);
  React.useEffect(() => {
    if (!revealedLoaded.current) return;
    AsyncStorage.setItem('bidmax_revealed', JSON.stringify(revealed)).catch(() => {});
  }, [revealed]);

  // Persist requested locations so "Requested ✓" sticks across restarts.
  const requestedLoaded = React.useRef(false);
  React.useEffect(() => {
    AsyncStorage.getItem('bidmax_requested').then(raw => {
      if (raw) { try { setRequested(JSON.parse(raw)); } catch {} }
      requestedLoaded.current = true;
    });
  }, []);
  React.useEffect(() => {
    if (!requestedLoaded.current) return;
    AsyncStorage.setItem('bidmax_requested', JSON.stringify(requested)).catch(() => {});
  }, [requested]);

  // Watchlist — lots the user saved to track. Stored as { lotId: endTimeSec } so
  // a lot can be auto-removed once its auction ends. Local to the device, persisted.
  const [watched, setWatched] = useState<Record<string, number>>({});
  const [watchedOnly, setWatchedOnly] = useState(false);
  const watchedSet = useMemo(() => new Set(Object.keys(watched)), [watched]);
  const watchedCount = watchedSet.size;
  const watchedLoaded = React.useRef(false);
  React.useEffect(() => {
    AsyncStorage.getItem('bidmax_watchlist').then(raw => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          // Migrate the old string[] format → { lotId: endTime } (0 = unknown).
          if (Array.isArray(parsed)) {
            const map: Record<string, number> = {};
            for (const id of parsed) map[String(id)] = 0;
            setWatched(map);
          } else if (parsed && typeof parsed === 'object') {
            setWatched(parsed as Record<string, number>);
          }
        } catch {}
      }
      watchedLoaded.current = true;
    });
  }, []);
  React.useEffect(() => {
    if (!watchedLoaded.current) return;
    AsyncStorage.setItem('bidmax_watchlist', JSON.stringify(watched)).catch(() => {});
  }, [watched]);
  const toggleWatch = useCallback((lotId: string, endTime = 0) => {
    setWatched(prev => {
      if (lotId in prev) { const { [lotId]: _omit, ...rest } = prev; return rest; }
      return { ...prev, [lotId]: endTime };
    });
  }, []);
  // Auto-un-heart a lot once its auction ends, so the count never strands a lot
  // you can no longer see to un-heart. Runs on the 1s clock tick.
  React.useEffect(() => {
    if (!watchedLoaded.current) return;
    setWatched(prev => {
      const nowSec = Date.now() / 1000;
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, end] of Object.entries(prev)) {
        if (end && end < nowSec) { changed = true; continue; } // ended → drop
        next[id] = end;
      }
      return changed ? next : prev;
    });
  }, [now]);
  // On each loaded list: refresh watched lots' end times from the data (handles
  // soft-close extensions) and drop legacy hearts with an unknown end time that
  // are no longer in the location (so old stranded hearts clear out).
  React.useEffect(() => {
    if (!watchedLoaded.current || !scannedAll || !items.length) return;
    const ends = new Map(items.map(i => [i.lotId, i.endTime] as const));
    setWatched(prev => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, end] of Object.entries(prev)) {
        if (ends.has(id)) {
          const e = ends.get(id) || end;
          if (e !== end) changed = true;
          next[id] = e;
        } else if (end === 0) {
          changed = true; // unknown-end heart not in this location → stale, drop
        } else {
          next[id] = end; // has a real end time → keep; the timer prunes it at end
        }
      }
      return changed ? next : prev;
    });
  }, [items, scannedAll]);

  // Scroll-to-top button, shown once the user scrolls past ~1.5 screens.
  const listRef = React.useRef<FlatList>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const onListScroll = useCallback((e: any) => {
    const should = e.nativeEvent.contentOffset.y > SCREEN_H * 1.5;
    setShowScrollTop(prev => (prev === should ? prev : should));
  }, []);
  const scrollToTop = () => listRef.current?.scrollToOffset({ offset: 0, animated: true });

  // Poll live bid/end data for the lots currently on screen (~5-8 at a time).
  const pollVisible = useCallback(async () => {
    if (!LIVE_BIDS_ENABLED) return;
    const ids = visibleIdsRef.current;
    if (!ids.length) return;
    const results = await Promise.all(ids.map(async id => [id, await fetchBidStatus(id)] as const));
    setLiveBids(prev => {
      const next = new Map(prev);
      for (const [id, status] of results) if (status) next.set(id, status);
      return next;
    });
  }, []);
  const pollRef = React.useRef(pollVisible);
  React.useEffect(() => { pollRef.current = pollVisible; }, [pollVisible]);

  // Stable (created once) so FlatList doesn't complain about changing handlers.
  const viewabilityConfig = React.useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = React.useRef((info: { viewableItems: Array<{ item: Listing }> }) => {
    visibleIdsRef.current = info.viewableItems.map(v => v.item.lotId);
    pollRef.current(); // fetch immediately for newly-visible lots
  }).current;

  // SSE stream for real-time bid/end updates; 1s tick drives local countdowns.
  React.useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    if (!LIVE_BIDS_ENABLED) return () => clearInterval(tick);

    let closed = false;
    let xhr: XMLHttpRequest | null = null;
    let lastIndex = 0;
    let buffer = '';

    function connect() {
      if (closed) return;
      // Abort the previous stream so its (unbounded) responseText buffer is freed.
      if (xhr) { try { xhr.abort(); } catch {} }
      lastIndex = 0;
      buffer = '';
      const x = new XMLHttpRequest();
      xhr = x;
      x.open('GET', `${SERVER_URL}/api/bid-stream`, true);
      x.onprogress = () => {
        if (closed || xhr !== x) return; // ignore a superseded connection
        const chunk = x.responseText.slice(lastIndex);
        lastIndex = x.responseText.length;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (!ev?.lotNumber) continue;
            setLiveBids(prev => {
              const next = new Map(prev);
              const existing = prev.get(ev.lotNumber);
              next.set(ev.lotNumber, {
                currentBid: ev.currentBid ?? existing?.currentBid ?? 0,
                endsAt: ev.endsAt ?? existing?.endsAt ?? 0,
                bidCount: ev.bidCount ?? existing?.bidCount ?? 0,
                highBidder: ev.highBidder ?? existing?.highBidder ?? null,
              });
              return next;
            });
          } catch {}
        }
      };
      x.onload = () => { if (!closed && xhr === x) setTimeout(connect, 3000); };
      x.onerror = () => { if (!closed && xhr === x) setTimeout(connect, 3000); };
      x.send();
    }

    connect();
    // Recycle the stream every few minutes so XHR responseText can't grow
    // unbounded over a long session (RN has no native EventSource).
    const recycle = setInterval(() => { if (!closed) connect(); }, 180000);

    return () => {
      closed = true;
      xhr?.abort();
      clearInterval(recycle);
      clearInterval(tick);
    };
  }, []);

  const canReveal = isPro || !usage || usage.limit == null || usage.used < usage.limit;

  // ── Loaders ──
  const scanItems = async (affiliateValue: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setItems([]); setLiveBids(new Map()); setScannedAll(false); setScanError(null); setPage(1);
    track('scan_items', { affiliateId: affiliateValue });
    try {
      const settingsArg = { targetMargin: settings.targetMargin, buyersPremium: settings.buyersPremium };

      // One request for the whole location (server-side all=true) — covers search
      // and the item count without paging through dozens of slow requests.
      setLoadingMsg('Loading items…');
      const { items: all } = await fetchItems(affiliateValue, 1, settingsArg, { sessionToken: sessionToken || undefined, all: true });

      setItems(all);
      setTotalPages(1);
      setPage(1);                // everything loaded in one shot → infinite-scroll no-ops
      setTotalItems(all.length); // exact count of what's actually loaded/searchable
      setScannedAll(true);
    } catch (e: any) {
      setScanError(e?.message || 'Something went wrong loading items.');
    } finally {
      setLoading(false); setLoadingMsg('');
    }
  };

  // Auto-load once on open if a location is already selected (restored from a
  // previous session) so items are pulled and ready without a manual tap.
  const didAutoScan = React.useRef(false);
  React.useEffect(() => {
    if (didAutoScan.current) return;
    if (settings.selectedAffiliate && !scannedAll && !loading) {
      didAutoScan.current = true;
      scanItems(settings.selectedAffiliate);
    }
  }, [settings.selectedAffiliate, scannedAll, loading]);

  // Infinite scroll for All Items — appends the next page of analyzed items.
  // Ref guard prevents onEndReached double-fires from fetching/appending twice.
  const loadingMoreRef = React.useRef(false);
  const loadMoreItems = async () => {
    if (view !== 'all' || loading || loadingMoreRef.current || page >= totalPages || !settings.selectedAffiliate) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const { items: list } = await fetchItems(
        settings.selectedAffiliate, next,
        { targetMargin: settings.targetMargin, buyersPremium: settings.buyersPremium },
        { sessionToken: sessionToken || undefined }
      );
      // Dedupe by lotId so a repeated/overlapping page can't add duplicates.
      setItems(prev => {
        const seen = new Set(prev.map(i => i.lotId));
        return [...prev, ...list.filter(i => !seen.has(i.lotId))];
      });
      setPage(next);
    } catch {
      // keep what we have on a page error
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // When the account upgrades (is_pro flips true), reload so /api/items returns the
  // now-unlocked resell values instead of the free nulls loaded earlier.
  const prevProRef = React.useRef(isPro);
  React.useEffect(() => {
    if (!prevProRef.current && isPro && settings.selectedAffiliate) {
      scanItems(settings.selectedAffiliate);
    }
    prevProRef.current = isPro;
  }, [isPro]);

  // ── Actions ──
  // Pull-to-refresh: reload all items for the current location like the initial
  // load, but WITHOUT the full-screen overlay — the native pull spinner covers it.
  const onRefresh = async () => {
    const aff = settings.selectedAffiliate;
    if (!aff) return;
    setRefreshing(true);
    try {
      await scanItems(aff, { silent: true });
    } catch (e: any) {
      Alert.alert('Refresh failed', e.message);
    } finally {
      setRefreshing(false);
    }
  };

  // Both "All Items" and "Fire Deals" read the same loaded item set; Fire Deals
  // just filters it client-side, so we only ever need to load items.
  const onToggleView = (v: ViewMode) => {
    setView(v);
    if (!settings.selectedAffiliate || loading) return;
    if (!scannedAll) scanItems(settings.selectedAffiliate);
  };

  const resetFilters = () => {
    setSortMode('ending');
    setWatchedOnly(false);
    if (view === 'picks') onToggleView('all');
  };

  const onRequestLocation = async (aff: Affiliate) => {
    setRequested(prev => (prev.includes(aff.id) ? prev : [...prev, aff.id])); // optimistic
    track('request_location', { affiliateId: aff.id });
    const ok = await requestLocation(aff, sessionToken || undefined);
    if (!ok) {
      setRequested(prev => prev.filter(id => id !== aff.id));
      Alert.alert('Request failed', 'Could not send your request — please try again.');
    }
  };

  const onSelectAffiliate = (aff: Affiliate) => {
    save({ selectedAffiliate: aff.value, affiliateName: aff.name });
    setShowPicker(false);
    setItems([]); setScannedAll(false);
    setView('all');
    scanItems(aff.value);
  };

  // Re-run the loader after an error.
  const retryLoad = () => {
    if (!settings.selectedAffiliate) { setShowPicker(true); return; }
    scanItems(settings.selectedAffiliate);
  };

  const onReveal = async (lotId: string) => {
    if (!canReveal) {
      track('limit_reached', { source: 'reveal_tap' });
      Alert.alert('Daily limit reached', `You've used all ${usage?.limit ?? 10} free analyses today. Upgrade to Pro for unlimited.`, [
        { text: 'Not now', style: 'cancel' },
        { text: 'Upgrade', onPress: () => router.push('/(tabs)/settings') },
      ]);
      return;
    }
    const item = items.find(i => i.lotId === lotId);
    if (!item) return;

    setAnalyzing(prev => [...prev, lotId]);
    try {
      const { saleValue, usage: revealUsage } = await analyzeItem(
        item,
        { targetMargin: settings.targetMargin, buyersPremium: settings.buyersPremium },
        sessionToken || undefined
      );
      setRevealed(prev => ({ ...prev, [lotId]: saleValue }));
      track('reveal_analysis', { lotId });
      // Prefer the exact count the server returned for this reveal; fall back to
      // a /auth/me refresh if the headers weren't present.
      if (revealUsage) setUsage(revealUsage); else refreshUsage();
    } catch (e: any) {
      if (e instanceof LimitReachedError) {
        setUsage({ used: e.used || 10, limit: e.limit || 10 });
        track('limit_reached', { source: 'server_402' });
        Alert.alert('Daily limit reached', 'Upgrade to Pro for unlimited analyses.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Upgrade', onPress: () => router.push('/(tabs)/settings') },
        ]);
      } else {
        Alert.alert('Analysis failed', e.message);
      }
    } finally {
      setAnalyzing(prev => prev.filter(id => id !== lotId));
    }
  };

  const activeFilterCount = (view === 'picks' ? 1 : 0) + (sortMode !== 'ending' ? 1 : 0) + (watchedOnly ? 1 : 0);
  const filtering = query.trim().length > 0;

  // ── Derived display data ──
  const display = useMemo(() => {
    let base: Listing[];
    if (view === 'picks') {
      if (!isPro) return [];
      // Every fire/hot deal from the full list (no cap): worth bidding AND
      // expected profit at or above the user's Fire Deal threshold.
      base = items
        .map(i => (i.saleValue != null ? i : (revealed[i.lotId] != null ? { ...i, saleValue: revealed[i.lotId] } : i)))
        .filter(i => {
          if (i.saleValue == null) return false;
          const bd = calcBid(i.saleValue, settings.targetMargin, i.buyersPremium);
          return bd.maxBid > 0 && i.currentBid < bd.maxBid && bd.expectedProfit >= settings.fireThreshold;
        });
    } else {
      // All Items. Pro: use the server's resale value; if a lot is missing one,
      // fall back to a value the user revealed. Free: only revealed values unlock.
      base = items.map(i => {
        const revealedVal = revealed[i.lotId];
        if (isPro) return i.saleValue != null ? i : (revealedVal != null ? { ...i, saleValue: revealedVal } : i);
        return { ...i, saleValue: revealedVal ?? null };
      });
    }

    const sorted = [...base].sort((a, b) => {
      switch (sortMode) {
        case 'ending_late': return (b.endTime || 0) - (a.endTime || 0);          // latest first
        case 'bid_high':    return b.currentBid - a.currentBid;
        case 'bid_low':     return a.currentBid - b.currentBid;
        case 'az':          return a.title.localeCompare(b.title);
        // 'ending' (default): soonest first; lots without an end time go last
        default:            return (a.endTime || Infinity) - (b.endTime || Infinity);
      }
    });

    let result = sorted;
    if (watchedOnly) result = result.filter(it => watchedSet.has(it.lotId));
    const q = query.trim().toLowerCase();
    return q
      ? result.filter(it =>
          it.title.toLowerCase().includes(q) ||
          it.lotId.toLowerCase().includes(q)
        )
      : result;
  }, [view, isPro, items, revealed, sortMode, query, watchedOnly, watchedSet, settings.targetMargin, settings.buyersPremium, settings.fireThreshold]);

  const scanned = scannedAll;
  const showStats = !loading && scanned && (view === 'all' || isPro);
  const proLocked = view === 'picks' && !isPro;

  return (
    <SafeAreaView style={styles.safe}>
      {/* Search (top of screen so the keyboard doesn't cover it) */}
      <View style={styles.searchRow}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search items…"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
            <Text style={styles.searchClear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Loading overlay — centered spinner with a status line */}
      {loading && (
        <View style={styles.progressOverlay} pointerEvents="none">
          <ActivityIndicator color={colors.green} size="large" />
          <Text style={styles.progressText}>{loadingMsg}</Text>
        </View>
      )}

      {/* Stats */}
      {showStats && (
        <View style={styles.statsBar}>
          <Text style={styles.statsText}>
            {view === 'picks'
              ? `🔥 Fire Deals · ${display.length}`
              : filtering
              ? `🛒 All Items · ${display.length} of ${totalItems || items.length}`
              : `🛒 All Items · ${totalItems || items.length} items`}
          </Text>
          <View style={styles.statsDot} />
          {view === 'picks' ? (
            <Text style={[styles.statsText, { color: colors.green }]}>Pro · unlimited</Text>
          ) : (
            <Text style={[styles.statsText, { color: colors.green }]}>
              {isPro ? 'Pro · unlimited' : `Analyses ${usage?.used ?? 0}/${usage?.limit ?? 10}`}
            </Text>
          )}
        </View>
      )}

      {/* Pro upsell (free users on Top Picks) */}
      {proLocked ? (
        <View style={styles.upsell}>
          <Text style={styles.upsellIcon}>✨</Text>
          <Text style={styles.upsellTitle}>Fire Deals is a Pro feature</Text>
          <Text style={styles.upsellSub}>
            We pre-analyze every lot and surface every fire deal — worth bidding with profit above your threshold — automatically. No taps, no daily limit.
          </Text>
          <TouchableOpacity style={styles.upsellBtn} onPress={() => router.push('/(tabs)/settings')} activeOpacity={0.85}>
            <Text style={styles.upsellBtnText}>⚡ Upgrade to Pro — $9.99/mo</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          onScroll={onListScroll}
          scrollEventThrottle={100}
          data={display}
          keyExtractor={d => d.lotId}
          renderItem={({ item, index }) => {
            const live = LIVE_BIDS_ENABLED ? liveBids.get(item.lotId) : undefined;
            // Real-time bid, count, and close time from the live poll; fall back to
            // the analyzed DB values until the lot's first poll returns.
            const merged = live
              ? { ...item, currentBid: live.currentBid, bidCount: live.bidCount, endTime: live.endsAt, highBidder: live.highBidder ?? item.highBidder }
              : item;
            return (
              <DealCard
                item={merged}
                rank={index + 1}
                targetMargin={settings.targetMargin}
                fireThreshold={settings.fireThreshold}
                analyzing={analyzing.includes(item.lotId)}
                canReveal={canReveal}
                onReveal={onReveal}
                isWatched={watchedSet.has(item.lotId)}
                onToggleWatch={toggleWatch}
                myBidder={settings.bidrlUsername}
                isLive={!!live}
                now={now}
              />
            );
          }}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.green}
              colors={[colors.green]}
            />
          }
          onEndReached={loadMoreItems}
          onEndReachedThreshold={0.5}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.green} style={{ paddingVertical: 20 }} /> : null}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.empty}>
                {scanError ? (
                  <>
                    <Text style={styles.emptyIcon}>⚠️</Text>
                    <Text style={styles.emptyTitle}>Couldn’t load</Text>
                    <Text style={styles.emptySub}>{scanError}</Text>
                    <TouchableOpacity style={styles.retryBtn} onPress={retryLoad} activeOpacity={0.85}>
                      <Text style={styles.retryBtnText}>Try again</Text>
                    </TouchableOpacity>
                  </>
                ) : !settings.selectedAffiliate ? (
                  <>
                    <Text style={styles.emptyIcon}>📍</Text>
                    <Text style={styles.emptyTitle}>Choose your auction house</Text>
                    <Text style={styles.emptySub}>Tap the location bar below to pick a BidRL location — it loads instantly.</Text>
                  </>
                ) : !scanned ? (
                  <>
                    <Text style={styles.emptyIcon}>⚡</Text>
                    <Text style={styles.emptyTitle}>Ready when you are</Text>
                    <Text style={styles.emptySub}>Pull down to load deals from {settings.affiliateName}.</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.emptyIcon}>🔍</Text>
                    <Text style={styles.emptyTitle}>Nothing here right now</Text>
                    <Text style={styles.emptySub}>Pull down to refresh, or pick a different location below.</Text>
                  </>
                )}
              </View>
            ) : null
          }
        />
      )}

      {showScrollTop && !proLocked && (
        <TouchableOpacity style={styles.scrollTopBtn} onPress={scrollToTop} activeOpacity={0.85}>
          <Text style={styles.scrollTopText}>↑</Text>
        </TouchableOpacity>
      )}

      {/* Bottom action area — filters + location (selecting a location scans). */}
      <View style={styles.scanWrap}>
        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={[styles.filterBtn, activeFilterCount > 0 && styles.filterBtnActive]}
            onPress={() => setShowFilters(true)}
            activeOpacity={0.8}
          >
            <Text style={[styles.filterBtnText, activeFilterCount > 0 && { color: colors.green }]}>Filter</Text>
            {activeFilterCount > 0 && (
              <View style={styles.filterBadge}><Text style={styles.filterBadgeText}>{activeFilterCount}</Text></View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.locationBar} onPress={() => setShowPicker(true)} activeOpacity={0.8}>
            <Text style={styles.locationBarText} numberOfLines={1}>
              📍 {settings.affiliateName || 'Select a location'}
            </Text>
            <Text style={styles.locationBarChange}>{settings.affiliateName ? 'Change ▾' : 'Choose ▾'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Location picker — centered pop-up over a dimmed backdrop */}
      <Modal
        visible={showPicker}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setShowPicker(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFill} onPress={() => setShowPicker(false)} />
          <View style={styles.popup}>
            <View style={styles.popupHeader}>
              <Text style={styles.popupTitle}>Select location</Text>
              <TouchableOpacity onPress={() => setShowPicker(false)} hitSlop={10}>
                <Text style={styles.popupClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.popupSub}>Tap an available location to scan it</Text>
            <ScrollView style={styles.popupList} bounces={false} showsVerticalScrollIndicator={false}>
              {affiliates.filter(a => a.active).map(aff => (
                <TouchableOpacity
                  key={aff.id}
                  style={[styles.affRow, settings.selectedAffiliate === aff.value && styles.affRowActive]}
                  onPress={() => onSelectAffiliate(aff)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.affText} numberOfLines={1}>📍 {aff.name}</Text>
                  {settings.selectedAffiliate === aff.value && <Text style={styles.affCheck}>✓</Text>}
                </TouchableOpacity>
              ))}

              {affiliates.some(a => !a.active) && (
                <Text style={styles.affSectionLabel}>Not available yet</Text>
              )}
              {affiliates.filter(a => !a.active).map(aff => (
                <View key={aff.id} style={styles.affRow}>
                  <Text style={[styles.affText, { color: colors.muted }]} numberOfLines={1}>📍 {aff.name}</Text>
                  {requested.includes(aff.id) ? (
                    <Text style={styles.affRequested}>Requested ✓</Text>
                  ) : (
                    <TouchableOpacity style={styles.requestBtn} onPress={() => onRequestLocation(aff)} hitSlop={6}>
                      <Text style={styles.requestBtnText}>Request</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Filters bottom sheet */}
      <Modal
        visible={showFilters}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowFilters(false)}
      >
        <View style={styles.sheetRoot}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setShowFilters(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 22 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Filters</Text>
              <TouchableOpacity style={styles.sheetClose} onPress={() => setShowFilters(false)} hitSlop={8}>
                <Text style={styles.sheetCloseX}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.sheetSection}>Sort by</Text>
            {SORT_ROWS.map(([key, label, icon]) => {
              const sel = sortMode === key;
              return (
                <TouchableOpacity key={key} style={[styles.sheetRow, sel && styles.sheetRowSel]} onPress={() => setSortMode(key)} activeOpacity={0.7}>
                  <Image source={icon} style={[styles.sheetIcon, { tintColor: sel ? colors.green : colors.muted }]} />
                  <Text style={[styles.sheetRowText, { flex: 1 }, sel && styles.sheetRowTextSel]}>{label}</Text>
                  <View style={[styles.radio, sel && styles.radioOn]}>{sel && <View style={styles.radioDot} />}</View>
                </TouchableOpacity>
              );
            })}

            <View style={styles.sheetDivider} />
            <Text style={styles.sheetSection}>Filters</Text>

            <View style={styles.sheetRow}>
              <Image source={require('../../assets/heart-filled.png')} style={[styles.sheetIcon, { tintColor: colors.muted }]} />
              <Text style={styles.sheetRowText}>Watched only</Text>
              {watchedCount > 0 && (
                <View style={styles.countBadge}><Text style={styles.countBadgeText}>{watchedCount}</Text></View>
              )}
              <View style={styles.flexSpacer} />
              <Switch
                value={watchedOnly}
                onValueChange={setWatchedOnly}
                trackColor={{ true: colors.green, false: colors.border }}
                thumbColor="#ffffff"
                ios_backgroundColor={colors.border}
              />
            </View>

            <View style={styles.sheetRow}>
              <Image source={require('../../assets/ic-trending-up.png')} style={[styles.sheetIcon, { tintColor: colors.muted }]} />
              <Text style={styles.sheetRowText}>Fire deals</Text>
              {!isPro && <View style={styles.proBadge}><Text style={styles.proBadgeText}>PRO</Text></View>}
              <View style={styles.flexSpacer} />
              <Switch
                value={view === 'picks'}
                onValueChange={(v) => {
                  if (!isPro) { setShowFilters(false); router.push('/(tabs)/settings'); return; }
                  onToggleView(v ? 'picks' : 'all');
                }}
                trackColor={{ true: colors.green, false: colors.border }}
                thumbColor="#ffffff"
                ios_backgroundColor={colors.border}
              />
            </View>

            <View style={styles.sheetFooter}>
              <TouchableOpacity style={styles.resetBtn} onPress={resetFilters} activeOpacity={0.8}>
                <Text style={styles.resetBtnText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.showBtn} onPress={() => setShowFilters(false)} activeOpacity={0.85}>
                <Text style={styles.showBtnText}>Show results</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <PromoModal visible={showPromo} onClose={closePromo} showSkip />
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0 },
  segment: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: 12, padding: 4, gap: 4, marginHorizontal: 16, marginTop: 12, marginBottom: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.green },
  segmentText: { color: c.muted, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: c.onPrimary },
  popupSegment: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: 12, padding: 4, gap: 4, marginHorizontal: 18, marginTop: 2, marginBottom: 8 },
  progressOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 48, zIndex: 10 },
  progressText: { color: c.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  statsBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  statsText: { color: c.muted, fontSize: 12, fontWeight: '600' },
  statsDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: c.border },
  sortScroll: { height: 50, flexGrow: 0 },
  sortRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  sortTab: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  sortTabActive: { backgroundColor: c.greenDim, borderColor: c.green },
  sortTabText: { color: c.muted, fontSize: 12, fontWeight: '600' },
  sortTabTextActive: { color: c.green },
  list: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 110 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 80, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  emptySub: { color: c.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  retryBtn: { backgroundColor: c.green, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, marginTop: 6 },
  retryBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '800' },
  upsell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 14 },
  upsellIcon: { fontSize: 52 },
  upsellTitle: { color: c.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  upsellSub: { color: c.muted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  upsellBtn: { backgroundColor: c.green, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, marginTop: 6 },
  upsellBtnText: { color: c.onPrimary, fontSize: 14, fontWeight: '800' },
  scrollTopBtn: {
    position: 'absolute', right: 16, bottom: 92, width: 44, height: 44, borderRadius: 22,
    backgroundColor: c.green, alignItems: 'center', justifyContent: 'center', zIndex: 20,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
  scrollTopText: { color: c.onPrimary, fontSize: 22, fontWeight: '800', marginTop: -2 },
  scanWrap: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.border, gap: 10 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.surface2, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: c.border, marginHorizontal: 16, marginTop: 10, marginBottom: 2 },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, color: c.text, fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 12 : 8 },
  searchClear: { color: c.muted, fontSize: 14, fontWeight: '700', paddingHorizontal: 4 },
  bottomRow: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  filterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.surface2, borderRadius: 12, paddingHorizontal: 16, borderWidth: 1, borderColor: c.border, justifyContent: 'center' },
  filterBtnActive: { borderColor: c.green, backgroundColor: c.greenDim },
  filterBtnText: { color: c.text, fontSize: 14, fontWeight: '700' },
  filterBadge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: c.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  filterBadgeText: { color: c.onPrimary, fontSize: 11, fontWeight: '800' },
  locationBar: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.surface2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1, borderColor: c.border },
  locationBarText: { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  locationBarChange: { color: c.green, fontSize: 13, fontWeight: '700' },
  clearFilters: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  clearFiltersText: { color: c.muted, fontSize: 13, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  modalRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  backdropFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  popup: {
    width: '100%', maxWidth: 360, maxHeight: SCREEN_H * 0.7,
    backgroundColor: c.surface, borderRadius: 20, borderWidth: 1, borderColor: c.border,
    overflow: 'hidden', paddingBottom: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 24, elevation: 12,
  },
  popupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18, paddingTop: 16 },
  popupTitle: { color: c.text, fontSize: 18, fontWeight: '800' },
  popupClose: { color: c.muted, fontSize: 18, fontWeight: '700' },
  popupSub: { color: c.muted, fontSize: 12, paddingHorizontal: 18, paddingTop: 2, paddingBottom: 8 },
  popupList: { maxHeight: SCREEN_H * 0.5 },
  affRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 14, borderTopWidth: 1, borderTopColor: c.border },
  affRowActive: { backgroundColor: c.greenDim },
  affText: { color: c.text, fontSize: 15, flex: 1 },
  affLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  affHeart: { width: 16, height: 16, tintColor: c.green },
  affCheck: { color: c.green, fontSize: 16, fontWeight: '700', marginLeft: 8 },

  // Filters bottom sheet
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 8, paddingBottom: 30, borderWidth: 1, borderColor: c.border },
  sheetHandle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 4 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 },
  sheetTitle: { color: c.text, fontSize: 22, fontWeight: '900' },
  sheetClose: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center' },
  sheetCloseX: { color: c.muted, fontSize: 14, fontWeight: '700' },
  sheetSection: { color: c.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, marginHorizontal: 8, borderRadius: 12 },
  sheetRowSel: { backgroundColor: c.greenDim },
  sheetIcon: { width: 22, height: 22, marginRight: 14 },
  sheetRowText: { color: c.text, fontSize: 16, fontWeight: '600' },
  sheetRowTextSel: { color: c.green, fontWeight: '700' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: c.green, backgroundColor: c.green },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffffff' },
  sheetDivider: { height: 1, backgroundColor: c.border, marginVertical: 10, marginHorizontal: 20 },
  countBadge: { backgroundColor: c.surface2, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1, marginLeft: 8 },
  countBadgeText: { color: c.muted, fontSize: 12, fontWeight: '700' },
  proBadge: { backgroundColor: c.greenDim, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  proBadgeText: { color: c.green, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  flexSpacer: { flex: 1 },
  sheetFooter: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 18 },
  resetBtn: { paddingVertical: 14, paddingHorizontal: 26, borderRadius: 12, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  resetBtnText: { color: c.text, fontSize: 15, fontWeight: '700' },
  showBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: c.green, alignItems: 'center', justifyContent: 'center' },
  showBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '800' },
  affUpgrade: { color: c.amber, fontSize: 12, fontWeight: '800', marginLeft: 8 },
  affSectionLabel: { color: c.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 6 },
  requestBtn: { backgroundColor: c.greenDim, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: c.green, marginLeft: 8 },
  requestBtnText: { color: c.green, fontSize: 12, fontWeight: '800' },
  affRequested: { color: c.muted, fontSize: 12, fontWeight: '700', marginLeft: 8 },
});
