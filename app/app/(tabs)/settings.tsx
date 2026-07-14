import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Linking, Platform, StatusBar, Alert, Switch, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../hooks/useTheme';
import { Palette, ThemeMode } from '../../services/theme';
import { useAuth } from '../../hooks/useAuth';
import { useSettings } from '../../hooks/useSettings';
import { calcBid } from '../../services/api';
import { purchasePro, restorePro } from '../../services/purchases';
import { deleteAccount, isOnTrial, isPaidPro, trialDaysLeft } from '../../services/auth';
import { PromoModal } from '../../components/PromoModal';
import { track } from '../../services/analytics';

function Slider({ value, min, max, step, onChange, color }: any) {
  const { colors } = useTheme();
  const styles = useMemo(() => slStyles(colors), [colors]);
  const tint = color || colors.green;
  // Simple +/- controls since RN slider needs a native module.
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: tint }]} />
      </View>
      <View style={styles.row}>
        <TouchableOpacity style={styles.btn} onPress={dec}><Text style={styles.btnText}>−</Text></TouchableOpacity>
        <Text style={[styles.val, { color: tint }]}>{value}</Text>
        <TouchableOpacity style={styles.btn} onPress={inc}><Text style={styles.btnText}>+</Text></TouchableOpacity>
      </View>
    </View>
  );
}

const slStyles = (c: Palette) => StyleSheet.create({
  track: { height: 4, backgroundColor: c.border, borderRadius: 2, marginVertical: 10, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  btn: { backgroundColor: c.surface2, borderRadius: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  btnText: { color: c.text, fontSize: 18, fontWeight: '700' },
  val: { fontSize: 16, fontWeight: '800', fontFamily: 'monospace' },
});

const THEME_OPTIONS: { key: ThemeMode; label: string; icon: string }[] = [
  { key: 'light', label: 'Light', icon: '☀️' },
  { key: 'dark', label: 'Dark', icon: '🌙' },
];

export default function SettingsScreen() {
  const { user, sessionToken, signOut, refresh } = useAuth();
  const { settings, save } = useSettings();
  const { colors, mode, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const ex = calcBid(100, settings.targetMargin, settings.buyersPremium);
  const [showPromo, setShowPromo] = useState(false);
  const onTrial = isOnTrial(user);
  const paidPro = isPaidPro(user);
  const trialDays = trialDaysLeft(user);
  const trialExpires = user?.trialEndsAt
    ? new Date(user.trialEndsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  const handleUpgrade = async () => {
    track('upgrade_tapped');
    try {
      const result = await purchasePro();
      if (result === 'success') {
        track('upgrade_success');
        Alert.alert('Purchase complete 🎉', 'Activating your Pro access — this can take a few seconds.');
        // Server flips is_pro via the RevenueCat webhook; poll /auth/me to catch it.
        await refresh();
        setTimeout(refresh, 3000);
        setTimeout(refresh, 8000);
      }
      // 'cancelled' → no-op
    } catch (e: any) {
      // Surface the full RevenueCat detail so config errors are debuggable on-device.
      const parts = [
        e?.message,
        e?.underlyingErrorMessage,
        (e?.readableErrorCode || e?.code) && `code: ${e.readableErrorCode || e.code}`,
      ].filter(Boolean) as string[];
      try {
        const info = JSON.stringify(e?.userInfo ?? {});
        if (info && info !== '{}') parts.push(info);
      } catch {}
      Alert.alert('Purchase failed', parts.join('\n\n') || 'Please try again.');
    }
  };

  const handleRestore = async () => {
    const ok = await restorePro();
    Alert.alert(
      ok ? 'Purchases restored' : 'Nothing to restore',
      ok ? 'Your Pro access is active.' : 'No active subscription was found for this account.'
    );
    if (ok) { await refresh(); setTimeout(refresh, 3000); }
  };

  // IAP subscriptions are managed in the OS store settings.
  const handleManage = () => {
    Linking.openURL(
      Platform.OS === 'ios'
        ? 'https://apps.apple.com/account/subscriptions'
        : 'https://play.google.com/store/account/subscriptions'
    );
  };

  // Required by both stores: a way to permanently delete the account in-app.
  const handleDeleteAccount = () => {
    const store = Platform.OS === 'ios' ? 'App Store' : 'Google Play';
    Alert.alert(
      'Delete account?',
      `This permanently deletes your BidMax account and data. This can’t be undone.\n\nNote: deleting your account does not cancel your subscription — manage that in your ${store} settings.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!sessionToken) { await signOut(); return; }
            const ok = await deleteAccount(sessionToken);
            if (ok) {
              track('account_deleted');
              await signOut();
              Alert.alert('Account deleted', 'Your account and data have been removed.');
            } else {
              Alert.alert('Couldn’t delete account', 'Something went wrong. Please try again, or contact MatthewJrenda@gmail.com.');
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

        {/* Account */}
        <View style={styles.card}>
          {user ? (
            <>
              <View style={styles.accountRow}>
                <View>
                  <Text style={styles.email}>{user.email}</Text>
                  <View style={[styles.badge, user.isPro ? styles.badgePro : styles.badgeFree]}>
                    <Text style={[styles.badgeText, !user.isPro && { color: colors.text }]}>{paidPro ? 'PRO' : onTrial ? 'PRO TRIAL' : 'FREE'}</Text>
                  </View>
                </View>
                <TouchableOpacity style={styles.signOutBtn} onPress={signOut}>
                  <Text style={styles.signOutText}>Sign out</Text>
                </TouchableOpacity>
              </View>
              {onTrial && (
                <>
                  <Text style={styles.proPitch}>
                    <Text style={styles.proPitchBold}>⚡ Pro Trial — {trialDays} {trialDays === 1 ? 'day' : 'days'} remaining.</Text> Expires {trialExpires}. Upgrade any time to keep Pro after your trial ends.
                  </Text>
                  <TouchableOpacity style={styles.upgradeBtn} onPress={handleUpgrade}>
                    <Text style={styles.upgradeBtnText}>⚡ Upgrade to Pro — $9.99/mo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.restoreBtn} onPress={handleRestore}>
                    <Text style={styles.restoreText}>Restore purchases</Text>
                  </TouchableOpacity>
                </>
              )}
              {paidPro && (
                <TouchableOpacity style={styles.manageBtn} onPress={handleManage}>
                  <Text style={styles.manageBtnText}>Manage Subscription</Text>
                </TouchableOpacity>
              )}
              {!user.isPro && (
                <>
                  <Text style={styles.proPitch}>
                    <Text style={styles.proPitchBold}>BidMax Pro — $9.99/month.</Text> Unlimited AI resale‑value analyses and Fire Deals — every profitable lot surfaced automatically. Auto‑renews monthly until cancelled; manage anytime in your {Platform.OS === 'ios' ? 'App Store' : 'Google Play'} account.
                  </Text>
                  <TouchableOpacity style={styles.upgradeBtn} onPress={handleUpgrade}>
                    <Text style={styles.upgradeBtnText}>⚡ Upgrade to Pro — $9.99/mo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.restoreBtn} onPress={handleRestore}>
                    <Text style={styles.restoreText}>Restore purchases</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.promoRow} onPress={() => setShowPromo(true)} activeOpacity={0.7}>
                    <Text style={styles.promoRowText}>🎟  Have a promo code?</Text>
                    <Text style={styles.promoRowChevron}>Enter code ›</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity style={styles.deleteBtn} onPress={handleDeleteAccount}>
                <Text style={styles.deleteText}>Delete account</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.signInPrompt}>
                Browsing is free, no account needed. Sign in to upgrade to Pro for unlimited analyses and Fire Deals.
              </Text>
              <TouchableOpacity style={styles.upgradeBtn} onPress={() => router.push('/(auth)/sign-in')}>
                <Text style={styles.upgradeBtnText}>Sign in to upgrade</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* BidRL username — flags winning/outbid on lots */}
        <View style={styles.card}>
          <Text style={styles.label}>Your BidRL username</Text>
          <Text style={styles.hint}>We'll flag the lots you're the high bidder on — 🏆 winning vs ⚠️ outbid.</Text>
          <TextInput
            style={styles.usernameInput}
            placeholder="e.g. Amfo"
            placeholderTextColor={colors.muted}
            value={settings.bidrlUsername}
            onChangeText={(t) => save({ bidrlUsername: t })}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Appearance */}
        <View style={styles.card}>
          <Text style={styles.label}>Appearance</Text>
          <View style={styles.segment}>
            {THEME_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.segmentItem, mode === opt.key && styles.segmentItemActive]}
                onPress={() => setMode(opt.key)}
                activeOpacity={0.8}
              >
                <Text style={[styles.segmentText, mode === opt.key && styles.segmentTextActive]}>
                  {opt.icon} {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ROI */}
        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Min ROI Target</Text>
            <Text style={[styles.labelVal, { color: colors.green }]}>{settings.targetMargin}%</Text>
          </View>
          <Slider min={10} max={200} step={5} value={settings.targetMargin} onChange={(v: number) => save({ targetMargin: v })} />
          <View style={styles.rangeRow}>
            <Text style={styles.rangeText}>10%</Text>
            <Text style={styles.rangeText}>200%</Text>
          </View>
        </View>

        {/* BP */}
        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Buyer's Premium</Text>
            <Text style={[styles.labelVal, { color: colors.green }]}>{settings.buyersPremium}%</Text>
          </View>
          <Text style={styles.hint}>Added on top of hammer price</Text>
          <Slider min={10} max={25} step={1} value={settings.buyersPremium} onChange={(v: number) => save({ buyersPremium: v })} />
          <View style={styles.rangeRow}>
            <Text style={styles.rangeText}>10%</Text>
            <Text style={styles.rangeText}>25%</Text>
          </View>
        </View>

        {/* Fire threshold */}
        <View style={styles.card}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>🔥 Fire Deal Threshold</Text>
            <Text style={[styles.labelVal, { color: colors.amber }]}>${settings.fireThreshold}</Text>
          </View>
          <Text style={styles.hint}>Profit above this gets a fire banner</Text>
          <Slider min={10} max={300} step={5} value={settings.fireThreshold} color={colors.amber} onChange={(v: number) => save({ fireThreshold: v })} />
          <View style={styles.rangeRow}>
            <Text style={styles.rangeText}>$10</Text>
            <Text style={styles.rangeText}>$300</Text>
          </View>
        </View>

        {/* Fire deal alerts (Pro only) */}
        {!!user?.isPro && (
          <View style={styles.card}>
            <View style={styles.emailRow}>
              <View style={styles.emailText}>
                <Text style={styles.label}>🔥 Fire deal alerts</Text>
                <Text style={styles.hint}>Get a push notification ~30 min before a fire deal ends — worth bidding with profit above your threshold.</Text>
              </View>
              <Switch
                value={settings.fireAlertsEnabled}
                onValueChange={(v) => save({ fireAlertsEnabled: v })}
                trackColor={{ true: colors.green, false: colors.border }}
                thumbColor="#ffffff"
                ios_backgroundColor={colors.border}
              />
            </View>
          </View>
        )}

        {/* Example */}
        <View style={styles.exCard}>
          <Text style={styles.exTitle}>Example on $100 sale</Text>
          <View style={styles.exRow}>
            {[
              ['MAX BID', `$${ex.maxBid}`, colors.green],
              ['TOTAL COST', `$${ex.totalCost}`, colors.text],
              ['PROFIT', `$${ex.expectedProfit}`, colors.green],
            ].map(([label, val, color]) => (
              <View key={label} style={styles.exStat}>
                <Text style={styles.exLabel}>{label}</Text>
                <Text style={[styles.exVal, { color }]}>{val}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Disclaimer */}
        <Text style={styles.disclaimer}>
          Resale values and max bids are AI-generated estimates for guidance only — not guarantees or
          financial advice. Auction outcomes vary; always do your own research before bidding. BidMax
          isn't affiliated with BidRL.
        </Text>
        <View style={styles.legalRow}>
          <TouchableOpacity onPress={() => Linking.openURL('https://bidmax-production.up.railway.app/terms.html')}>
            <Text style={styles.legalLink}>Terms</Text>
          </TouchableOpacity>
          <Text style={styles.legalDot}>·</Text>
          <TouchableOpacity onPress={() => Linking.openURL('https://bidmax-production.up.railway.app/privacy-policy.html')}>
            <Text style={styles.legalLink}>Privacy</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
      <PromoModal visible={showPromo} onClose={() => setShowPromo(false)} />
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0 },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  heading: { color: c.text, fontSize: 24, fontWeight: '900', marginBottom: 4 },
  card: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 16, gap: 8 },
  accountRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  email: { color: c.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, alignSelf: 'flex-start' },
  badgePro: { backgroundColor: c.green },
  badgeFree: { backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border },
  badgeText: { fontSize: 10, fontWeight: '800', color: c.onPrimary, letterSpacing: 0.5 },
  signOutBtn: { padding: 8 },
  signOutText: { color: c.muted, fontSize: 13 },
  upgradeBtn: { backgroundColor: c.green, borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 4 },
  upgradeBtnText: { color: c.onPrimary, fontWeight: '800', fontSize: 14 },
  signInPrompt: { color: c.muted, fontSize: 13, lineHeight: 18, marginBottom: 2 },
  proPitch: { color: c.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  proPitchBold: { color: c.text, fontWeight: '800' },
  promoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, marginTop: 2, borderTopWidth: 1, borderTopColor: c.border },
  promoRowText: { color: c.text, fontSize: 13, fontWeight: '600' },
  promoRowChevron: { color: c.green, fontSize: 13, fontWeight: '700' },
  manageBtn: { backgroundColor: c.surface2, borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: c.border },
  manageBtnText: { color: c.muted, fontSize: 13 },
  restoreBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  restoreText: { color: c.muted, fontSize: 13, fontWeight: '600' },
  deleteBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  deleteText: { color: c.red, fontSize: 13, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: c.surface2, borderRadius: 10, padding: 4, gap: 4, marginTop: 4 },
  segmentItem: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.green },
  segmentText: { color: c.muted, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: c.onPrimary },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: c.text, fontSize: 14, fontWeight: '600' },
  labelVal: { fontSize: 16, fontWeight: '800', fontFamily: 'monospace' },
  hint: { color: c.muted, fontSize: 11 },
  usernameInput: { backgroundColor: c.surface2, borderRadius: 10, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 14, fontWeight: '600', paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 },
  emailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  emailText: { flex: 1 },
  rangeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  rangeText: { color: c.muted, fontSize: 11 },
  exCard: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 16 },
  exTitle: { color: c.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
  exRow: { flexDirection: 'row', justifyContent: 'space-between' },
  exStat: { alignItems: 'center', gap: 4 },
  exLabel: { color: c.muted, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  exVal: { fontSize: 20, fontWeight: '800', fontFamily: 'monospace' },
  disclaimer: { color: c.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', paddingHorizontal: 8, marginTop: 4 },
  legalRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 2 },
  legalLink: { color: c.muted, fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  legalDot: { color: c.muted, fontSize: 12 },
});
