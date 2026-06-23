import React, { useMemo, useRef, useEffect } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../hooks/useTheme';
import { Palette } from '../services/theme';
import { Listing, calcBid, isWorthBidding } from '../services/api';

interface Props {
  item: Listing;
  rank: number;
  targetMargin: number;
  fireThreshold: number;
  analyzing: boolean;
  canReveal: boolean;
  onReveal: (lotId: string) => void;
  isWatched?: boolean;
  onToggleWatch?: (lotId: string, endTime?: number) => void;
  myBidder?: string;   // the user's BidRL username, to flag winning/outbid
  isLive?: boolean;
  now?: number;
}

function timeLeft(endTime: number, now: number): string {
  if (!endTime) return '';
  const diff = endTime * 1000 - now;
  if (diff <= 0) return 'Ended';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function DealCard({ item, rank, targetMargin, fireThreshold, analyzing, canReveal, onReveal, isWatched = false, onToggleWatch, myBidder, isLive = false, now = Date.now() }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const highBidder = item.highBidder;
  // Normalize both before comparing: strip all whitespace (incl. zero-width chars
  // that sneak in from copy-paste), NFKC-normalize, lowercase.
  const normUser = (s?: string | null) => (s ?? '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g, '').toLowerCase();
  const winning = !!highBidder && !!normUser(myBidder) && normUser(highBidder) === normUser(myBidder);

  const analyzed = item.saleValue != null;
  const bd = analyzed ? calcBid(item.saleValue as number, targetMargin, item.buyersPremium) : null;
  const worth = bd ? isWorthBidding({ maxBid: bd.maxBid, currentBid: item.currentBid }) : false;
  const isHot = !!bd && worth && bd.expectedProfit >= fireThreshold;
  const valueColor = worth ? colors.green : colors.red;
  const tl = timeLeft(item.endTime, now);
  const ended = tl === 'Ended';

  // Fade the LIVE tag in instead of popping it (and it sits after the bid so the
  // bid number never shifts).
  const liveAnim = useRef(new Animated.Value(isLive ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(liveAnim, { toValue: isLive ? 1 : 0, duration: 250, useNativeDriver: true }).start();
  }, [isLive, liveAnim]);

  // Open the BidRL lot in an in-app browser (SFSafariViewController / Chrome Custom
  // Tabs) so the user's existing BidRL login carries over from the system browser —
  // a sandboxed WebView would force them to log in again inside the sheet.
  const openListing = () => {
    if (!item.itemUrl) return;
    WebBrowser.openBrowserAsync(item.itemUrl, {
      toolbarColor: colors.surface,
      controlsColor: colors.green,
      dismissButtonStyle: 'close',
    }).catch(() => {});
  };

  return (
    <TouchableOpacity
      style={[styles.card, isHot && styles.cardHot, analyzed && !worth && styles.cardSkip]}
      onPress={openListing}
      activeOpacity={0.85}
    >
      {isHot && (
        <View style={styles.hotBanner}>
          <Text style={styles.hotText}>🔥 HOT DEAL — ${bd!.expectedProfit} profit potential</Text>
        </View>
      )}
      {analyzed && !worth && (
        <View style={styles.skipBanner}>
          <Text style={styles.skipText}>⚠️ Current bid above your max (${bd!.maxBid}) — not worth it</Text>
        </View>
      )}

      <View style={styles.body}>
        {item.imageUrl ? (
          <Image source={{ uri: item.imageUrl }} style={styles.img} />
        ) : (
          <View style={[styles.img, styles.imgPlaceholder]}>
            <Text style={{ fontSize: 24 }}>📦</Text>
          </View>
        )}
        <View style={styles.info}>
          <View style={styles.rankRow}>
            <Text style={styles.rank}>#{rank} · {item.lotId}</Text>
            {onToggleWatch && (
              <TouchableOpacity onPress={() => onToggleWatch(item.lotId, item.endTime)} hitSlop={10} activeOpacity={0.7} style={styles.heartBtn}>
                <Image
                  source={isWatched ? require('../assets/heart-filled.png') : require('../assets/heart-outline.png')}
                  style={[styles.heartImg, { tintColor: isWatched ? colors.green : colors.muted }]}
                />
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
          <View style={styles.metaRow}>
            <View style={styles.live}>
              <Text style={styles.bid}>${item.currentBid.toFixed(2)}</Text>
              {item.bidCount > 0 && <Text style={styles.bidCount}>· {item.bidCount} bids</Text>}
              {isLive && (
                <Animated.View style={[styles.liveTag, { opacity: liveAnim }]}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>LIVE</Text>
                </Animated.View>
              )}
            </View>
            {!!tl && <Text style={[styles.timeLeft, ended && { color: colors.red }]}>⏱ {tl}</Text>}
          </View>
          {!!highBidder && (
            winning
              ? <Text style={[styles.bidder, styles.bidderWin]} numberOfLines={1}>🏆 You're the high bidder</Text>
              : <Text style={styles.bidder} numberOfLines={1}>👤 High bidder: {highBidder}</Text>
          )}
        </View>
      </View>

      {analyzed ? (
        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>RESELL</Text>
            <Text style={[styles.statVal, { color: colors.text }]}>${item.saleValue}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statLabel}>MAX BID</Text>
            <Text style={[styles.statVal, { color: valueColor }]}>${bd!.maxBid}</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statLabel}>PROFIT</Text>
            <Text style={[styles.statVal, { color: valueColor }]}>${bd!.expectedProfit}</Text>
          </View>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.revealBtn, !canReveal && styles.revealBtnLocked]}
          onPress={() => onReveal(item.lotId)}
          disabled={analyzing}
          activeOpacity={0.8}
        >
          {analyzing ? (
            <>
              <ActivityIndicator color={colors.green} size="small" />
              <Text style={styles.revealText}>Analyzing…</Text>
            </>
          ) : (
            <Text style={[styles.revealText, !canReveal && styles.revealTextLocked]}>
              {canReveal ? '🔍 Reveal analysis' : '🔒 Daily limit reached — Upgrade'}
            </Text>
          )}
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  cardHot: {
    borderColor: c.amber,
    shadowColor: c.amberGlow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 8,
  },
  cardSkip: { opacity: 0.6 },
  hotBanner: {
    backgroundColor: c.amberDim,
    borderBottomWidth: 1,
    borderBottomColor: c.amber,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  hotText: { color: c.amber, fontSize: 11, fontWeight: '800' },
  skipBanner: {
    backgroundColor: c.redDim,
    borderBottomWidth: 1,
    borderBottomColor: c.red,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  skipText: { color: c.red, fontSize: 11, fontWeight: '700' },
  body: { flexDirection: 'row', gap: 12, padding: 12 },
  img: { width: 72, height: 72, borderRadius: 10, backgroundColor: c.surface2 },
  imgPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, gap: 4, justifyContent: 'center' },
  rankRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rank: { color: c.muted, fontSize: 10, fontWeight: '700' },
  heartBtn: { padding: 2 },
  heartImg: { width: 20, height: 20 },
  title: { color: c.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 4 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.red },
  liveText: { color: c.red, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  bid: { color: c.text, fontSize: 13, fontWeight: '700' },
  bidCount: { color: c.muted, fontSize: 11, fontWeight: '600' },
  timeLeft: { color: c.amber, fontSize: 11, fontWeight: '700' },
  bidder: { color: c.muted, fontSize: 11, fontWeight: '600', marginTop: 3 },
  bidderWin: { color: c.green, fontWeight: '800' },
  stats: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface2,
  },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 2 },
  statDivider: { width: 1, backgroundColor: c.border, marginVertical: 8 },
  statLabel: { color: c.muted, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  statVal: { fontSize: 17, fontWeight: '800', color: c.text },
  revealBtn: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.greenDim,
  },
  revealBtnLocked: { backgroundColor: c.surface2 },
  revealText: { color: c.green, fontSize: 13, fontWeight: '700' },
  revealTextLocked: { color: c.muted },
});
