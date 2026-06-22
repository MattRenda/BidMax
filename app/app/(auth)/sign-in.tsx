import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  SafeAreaView, ActivityIndicator, Alert, Platform, ScrollView
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SERVER_URL } from '../../services/config';
import { useTheme } from '../../hooks/useTheme';
import { Palette } from '../../services/theme';
import { verifySession, saveAuth, appleSignIn, demoSignIn } from '../../services/auth';
import { useAuth } from '../../hooks/useAuth';

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  // Which provider is mid-sign-in, so the spinner shows on the right button.
  const [busy, setBusy] = useState<null | 'apple' | 'google' | 'demo'>(null);
  const router = useRouter();
  const { refresh } = useAuth();
  const { colors, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // Sign in with Apple (iOS only). Native flow → identity token → our server.
  // Required by App Store guideline 4.8 alongside the Google option.
  const handleAppleSignIn = async () => {
    if (busy) return;
    setBusy('apple');
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('Apple did not return an identity token');
      // fullName/email arrive only on the first authorization; forward when present.
      const fullName = credential.fullName
        ? [credential.fullName.givenName, credential.fullName.familyName].filter(Boolean).join(' ')
        : undefined;
      const sessionToken = await appleSignIn({ identityToken: credential.identityToken, fullName, email: credential.email });

      const verified = await verifySession(sessionToken);
      if (!verified?.user) throw new Error('Session token was rejected by the server');
      await saveAuth(verified.user, sessionToken);
      await refresh();
      router.replace('/(tabs)');
    } catch (e: any) {
      if (e?.code === 'ERR_REQUEST_CANCELED') return; // user dismissed the Apple sheet
      Alert.alert('Sign in failed', e.message || 'Please try again');
    } finally {
      setBusy(null);
    }
  };

  // Demo login (no OAuth) — lets App Review and curious users explore the full
  // app, including Pro, without signing in.
  const handleDemoSignIn = async () => {
    if (busy) return;
    setBusy('demo');
    try {
      const sessionToken = await demoSignIn();
      const verified = await verifySession(sessionToken);
      if (!verified?.user) throw new Error('Session token was rejected by the server');
      await saveAuth(verified.user, sessionToken);
      await refresh();
      router.replace('/(tabs)');
    } catch (e: any) {
      Alert.alert('Demo sign in failed', e.message || 'Please try again');
    } finally {
      setBusy(null);
    }
  };

  const handleGoogleSignIn = async () => {
    if (busy) return;
    setBusy('google');
    try {
      // Server-callback flow: the app never talks to Google directly. It opens
      // our server's start endpoint, the server runs the full OAuth exchange with
      // its Web client + secret, then redirects back into the app at `returnUrl`
      // carrying a session token. Google only ever sees the server's https
      // callback, so no Android client / SHA-1 is required.
      // Pin the scheme so this is always `bidmax://auth-callback`, regardless of
      // runtime. (Without an explicit scheme it inherits exp:// in Expo Go / dev
      // server, which the server rejects and the OS can't route back to the app.)
      const returnUrl = Linking.createURL('auth-callback', { scheme: 'bidmax' });
      console.log('[auth] returnUrl =', returnUrl);

      const startUrl = `${SERVER_URL}/auth/google-mobile/start?returnUrl=${encodeURIComponent(returnUrl)}`;
      const result = await WebBrowser.openAuthSessionAsync(startUrl, returnUrl);

      if (result.type !== 'success' || !result.url) {
        // 'cancel'/'dismiss' means the user closed the browser — not an error.
        if (result.type === 'cancel' || result.type === 'dismiss') return;
        throw new Error('Sign in was not completed');
      }

      const { queryParams } = Linking.parse(result.url);
      const sessionToken = typeof queryParams?.sessionToken === 'string' ? queryParams.sessionToken : undefined;
      const serverError = typeof queryParams?.error === 'string' ? queryParams.error : undefined;

      if (serverError) throw new Error(decodeURIComponent(serverError));
      if (!sessionToken) throw new Error('Server did not return a session token');

      // Resolve the token into a user (and confirm it's valid) before storing.
      const verified = await verifySession(sessionToken);
      if (!verified?.user) throw new Error('Session token was rejected by the server');

      await saveAuth(verified.user, sessionToken);
      await refresh();
      router.replace('/(tabs)');
    } catch (e: any) {
      Alert.alert('Sign in failed', e.message || 'Please try again');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.safe}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>B</Text>
          </View>
          <Text style={styles.title}>BidMax</Text>
          <Text style={styles.subtitle}>Built for BidRL Bidders</Text>
          <Text style={styles.tagline}>
            Find the best resell opportunities at your local BidRL auction — before anyone else.
          </Text>
        </View>

        <View style={styles.features}>
          {[
            { icon: '💰', title: 'Know what it’ll resell for', desc: 'See each lot’s real resale value before you bid.' },
            { icon: '🎯', title: 'Never overpay again', desc: 'Get your exact max bid for the profit you want.' },
            { icon: '🔥', title: 'Spot the money-makers', desc: 'The best flips are flagged the second you scan.' },
          ].map(f => (
            <View key={f.title} style={styles.feature}>
              <Text style={styles.featureIcon}>{f.icon}</Text>
              <View style={styles.featureTextWrap}>
                <Text style={styles.featureTitle}>{f.title}</Text>
                <Text style={styles.featureDesc}>{f.desc}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          {Platform.OS === 'ios' && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={
                scheme === 'dark'
                  ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                  : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={14}
              style={styles.appleBtn}
              onPress={handleAppleSignIn}
            />
          )}
          <TouchableOpacity
            style={styles.googleBtn}
            onPress={handleGoogleSignIn}
            disabled={!!busy}
            activeOpacity={0.85}
          >
            {busy === 'google' ? (
              <ActivityIndicator color={colors.onPrimary} size="small" />
            ) : (
              <>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.googleText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={handleDemoSignIn} disabled={!!busy} style={styles.demoBtn} activeOpacity={0.7}>
            {busy === 'demo' ? (
              <ActivityIndicator color={colors.muted} size="small" />
            ) : (
              <Text style={styles.demoText}>Explore with a demo account</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.legal}>
            By continuing you agree to our Terms of Service. Free: 10 analyses/day. Pro: $9.99/mo unlimited.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  container: { flexGrow: 1, padding: 24, justifyContent: 'space-between' },
  hero: { alignItems: 'center', paddingTop: 40 },
  logo: {
    width: 72, height: 72,
    backgroundColor: c.green,
    borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
    shadowColor: c.greenGlow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 20,
    elevation: 8,
  },
  logoText: { fontSize: 32, fontWeight: '900', color: c.onPrimary },
  title: { fontSize: 32, fontWeight: '900', color: c.text, letterSpacing: -1 },
  subtitle: { fontSize: 14, color: c.muted, marginTop: 4, marginBottom: 20 },
  tagline: { fontSize: 15, color: c.muted, textAlign: 'center', lineHeight: 22 },
  features: { gap: 14 },
  feature: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, backgroundColor: c.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: c.border },
  featureIcon: { fontSize: 24, marginTop: 1 },
  featureTextWrap: { flex: 1, minWidth: 0, gap: 2 },
  featureTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  featureDesc: { color: c.muted, fontSize: 12.5, lineHeight: 17 },
  actions: { gap: 16 },
  appleBtn: { height: 52, width: '100%' },
  googleBtn: {
    backgroundColor: c.green,
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  googleIcon: { fontSize: 18, fontWeight: '900', color: c.onPrimary },
  googleText: { fontSize: 16, fontWeight: '800', color: c.onPrimary },
  demoBtn: { alignItems: 'center', paddingVertical: 6 },
  demoText: { color: c.muted, fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  legal: { fontSize: 11, color: c.muted, textAlign: 'center', lineHeight: 16 },
});
