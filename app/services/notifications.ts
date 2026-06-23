import { Platform } from 'react-native';
import { SERVER_URL } from './config';

// EAS project id (also in app.json extra.eas.projectId) — needed to mint an Expo
// push token in release builds.
const PROJECT_ID = 'd4cbd839-f0e3-491d-a6de-800e71300c4a';

// Lazy/guarded load: expo-notifications is a NATIVE module present only in builds
// that bundled it (the 1.1.0+ binaries). This JS can be OTA'd onto older builds
// that lack it, so we never import it at module top level — we require it on
// demand and return null if the native side isn't there, leaving push a safe
// no-op until users update.
function getNotifications(): any | null {
  try {
    const N = require('expo-notifications');
    if (!N || typeof N.getExpoPushTokenAsync !== 'function') return null;
    return N;
  } catch {
    return null;
  }
}

let handlerSet = false;
function ensureHandler(N: any) {
  if (handlerSet) return;
  try {
    // Show alerts while the app is foregrounded.
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerSet = true;
  } catch {}
}

// Request permission + return an Expo push token (or null if denied/unavailable).
// Safe to call on any build — returns null when the native module isn't present.
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const N = getNotifications();
  if (!N) return null;
  try {
    ensureHandler(N);
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: N.AndroidImportance.DEFAULT,
      });
    }
    const existing = await N.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await N.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;
    const token = await N.getExpoPushTokenAsync({ projectId: PROJECT_ID });
    return token.data;
  } catch {
    return null;
  }
}

// Register + push the Expo token to the server so it can send fire-deal alerts.
// No-op (returns false) when push isn't available on this build or permission is
// denied. Call when signed in and fire alerts are enabled.
export async function syncPushToken(sessionToken: string): Promise<boolean> {
  if (!sessionToken) return false;
  const token = await registerForPushNotificationsAsync();
  if (!token) return false;
  try {
    const res = await fetch(`${SERVER_URL}/api/push-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
