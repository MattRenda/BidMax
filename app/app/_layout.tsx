import { useEffect } from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../hooks/useAuth';
import { ThemeProvider, useTheme } from '../hooks/useTheme';
import { useSettings } from '../hooks/useSettings';
import { initPurchases } from '../services/purchases';
import { syncSettings } from '../services/auth';

function RootNavigator() {
  const { user, loading, sessionToken } = useAuth();
  const { settings } = useSettings();
  const { colors, scheme } = useTheme();
  const segments = useSegments();
  const router = useRouter();

  // Tie RevenueCat to the signed-in user so IAP purchases map to their account.
  useEffect(() => {
    if (user?.id) initPurchases(user.id);
  }, [user?.id]);

  // Sync fire-deal settings to the server (debounced) so it can compute fire
  // deals for notifications. Only when signed in; ignored otherwise.
  useEffect(() => {
    if (!sessionToken) return;
    const t = setTimeout(() => {
      syncSettings(sessionToken, settings);
    }, 800);
    return () => clearTimeout(t);
  }, [sessionToken, settings.targetMargin, settings.buyersPremium, settings.fireThreshold, settings.fireAlertsEnabled]);

  // Make the Android system nav bar transparent and match its button icons to
  // the theme so it blends into the app. (No-op on iOS, which has no nav buttons.)
  // Loaded lazily + guarded so a dev build that predates this native module
  // keeps running instead of crashing at startup — it activates after a rebuild.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let NavigationBar: typeof import('expo-navigation-bar') | undefined;
    try {
      NavigationBar = require('expo-navigation-bar');
    } catch {
      return;
    }
    // On a dev build that predates this native module, the require can resolve to
    // an empty module instead of throwing — so confirm the API is really present.
    if (!NavigationBar || typeof NavigationBar.setButtonStyleAsync !== 'function') return;
    NavigationBar.setButtonStyleAsync(scheme === 'dark' ? 'light' : 'dark').catch(() => {});
    NavigationBar.setBackgroundColorAsync('#00000000').catch(() => {});
    NavigationBar.setPositionAsync('absolute').catch(() => {});
  }, [scheme]);

  useEffect(() => {
    if (loading) return;

    // Login is OPTIONAL: browsing lots/bids must work without an account
    // (App Store guideline 5.1.1(v)). We only bounce an already-signed-in user
    // OFF the auth screens — we never force an anonymous user TO them. Sign-in is
    // reached on demand (Settings → Sign in) for account features like Pro.
    const inAuthGroup = segments[0] === '(auth)';
    if (user && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, segments]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <ActivityIndicator color={colors.green} size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}
