import * as SecureStore from 'expo-secure-store';
import { SERVER_URL } from './config';

const SESSION_KEY = 'bidmax_session';
const USER_KEY = 'bidmax_user';
const DEVICE_KEY = 'bidmax_device_id';

// Stable per-install device id. The server tracks free-tier usage by device, so
// the same id must be sent to /api/analyze-batch and /auth/me.
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  return id;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  isPro: boolean;               // paid Pro OR active trial
  trialEndsAt: string | null;   // ISO date while on a promo trial, else null
}

// On a promo trial when trial_ends_at is set and still in the future.
export function isOnTrial(user: User | null): boolean {
  return !!user?.trialEndsAt && new Date(user.trialEndsAt).getTime() > Date.now();
}

// Pro via payment (not a trial). Used to decide whether to show promo/upgrade UI.
export function isPaidPro(user: User | null): boolean {
  return !!user?.isPro && !isOnTrial(user);
}

// Whole days left on the trial (rounded up), 0 if not on one.
export function trialDaysLeft(user: User | null): number {
  if (!user?.trialEndsAt) return 0;
  const ms = new Date(user.trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

export interface AuthState {
  user: User | null;
  sessionToken: string | null;
  deviceId: string | null;
}

export async function getStoredAuth(): Promise<AuthState> {
  try {
    const sessionToken = await SecureStore.getItemAsync(SESSION_KEY);
    const userJson = await SecureStore.getItemAsync(USER_KEY);
    const user = userJson ? JSON.parse(userJson) : null;
    return { user, sessionToken, deviceId: null };
  } catch {
    return { user: null, sessionToken: null, deviceId: null };
  }
}

export async function saveAuth(user: User, sessionToken: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, sessionToken);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function clearAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

// Normalize a server user into the app's shape. Reads `is_pro` (snake_case) as
// the source of truth, but tolerates `isPro` so either server casing works.
function normalizeUser(u: any): User {
  return {
    id: String(u?.id ?? ''),
    email: u?.email ?? '',
    name: u?.name,
    isPro: !!(u?.is_pro ?? u?.isPro),
    trialEndsAt: u?.trial_ends_at ?? u?.trialEndsAt ?? null,
  };
}

// Redeem a promo code for a Pro trial. Throws with the server's message on failure
// (e.g. already redeemed, invalid/expired). Returns the updated user + trial end.
export async function redeemPromo(
  sessionToken: string,
  promoCode: string,
): Promise<{ user: User; trialEndsAt: string | null }> {
  const res = await fetch(`${SERVER_URL}/auth/redeem-promo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ promoCode: promoCode.trim() }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error(data?.message || data?.error || 'Could not redeem this code.');
  return {
    user: normalizeUser(data.user),
    trialEndsAt: data.trialEndsAt ?? data.user?.trial_ends_at ?? null,
  };
}

export async function verifySession(sessionToken: string): Promise<{ user: User; usage: any } | null> {
  try {
    const deviceId = await getDeviceId();
    const res = await fetch(`${SERVER_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}`, 'x-device-id': deviceId },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.user) return null;
    return { user: normalizeUser(data.user), usage: data.usage };
  } catch {
    return null;
  }
}

export interface Usage {
  used: number;
  limit: number | null; // null = unlimited (Pro)
}

// Current analysis usage for the day, from /auth/me. null if it can't be read.
export async function fetchUsage(sessionToken: string): Promise<Usage | null> {
  const me = await verifySession(sessionToken);
  if (!me?.usage) return null;
  const { used, limit } = me.usage;
  return { used: Number(used) || 0, limit: limit == null ? null : Number(limit) };
}

// Current usage for the day by device id — works for anonymous free users, whose
// count is device-tracked and not readable via /auth/me (which needs a session).
// Sends the session too when signed in so the server can resolve Pro/unlimited.
export async function fetchUsageByDevice(sessionToken?: string): Promise<Usage | null> {
  try {
    const deviceId = await getDeviceId();
    const res = await fetch(`${SERVER_URL}/api/usage`, {
      headers: {
        'X-Device-Id': deviceId,
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
    });
    if (!res.ok) return null;
    const d = await res.json();
    return { used: Number(d.used) || 0, limit: d.limit == null ? null : Number(d.limit) };
  } catch {
    return null;
  }
}

// The server may return the session token as a plain string OR as the full
// session row ({ token, ... }). Accept either and return the token string.
function extractSessionToken(v: any): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v.token === 'string') return v.token;
  return undefined;
}

// Push the user's fire-deal settings to the server so it can compute fire deals
// server-side (for notifications). Fire-and-forget — not critical to app function.
export async function syncSettings(
  sessionToken: string,
  s: { targetMargin: number; buyersPremium: number; fireThreshold: number; fireAlertsEnabled: boolean },
): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        targetMargin: s.targetMargin,
        buyersPremium: s.buyersPremium,
        fireThreshold: s.fireThreshold,
        emailFireAlerts: s.fireAlertsEnabled,
      }),
    });
  } catch {}
}

// Demo login that bypasses OAuth entirely. Used by App Review to access Pro
// features without a login code (guideline 2.1(a)), and by users who want to try
// the app first. The server returns a session token for a shared demo account
// (flagged Pro). Keep the demo account read-only / disposable server-side.
export async function demoSignIn(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/auth/demo`, { method: 'POST' });
  if (!res.ok) throw new Error('Demo sign-in is unavailable right now');
  const data = await res.json();
  const token = extractSessionToken(data?.sessionToken);
  if (!token) throw new Error('Server did not return a session token');
  return token;
}

// Sign in with Apple: the native flow returns an identity token (a JWT) on the
// device; we hand it to the server, which verifies it against Apple's public
// keys and returns one of our session tokens. Apple sends email/name only on the
// FIRST authorization, so we forward them when present and the server persists
// them keyed by the Apple user id (the token's stable `sub`).
export async function appleSignIn(payload: {
  identityToken: string;
  fullName?: string;
  email?: string | null;
}): Promise<string> {
  const res = await fetch(`${SERVER_URL}/auth/apple`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identityToken: payload.identityToken,
      fullName: payload.fullName || undefined,
      email: payload.email || undefined,
    }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    // Surface the server's real reason (e.g. audience mismatch) instead of a generic message.
    throw new Error(data?.detail || data?.error || 'Apple sign-in was rejected by the server');
  }
  const token = extractSessionToken(data?.sessionToken);
  if (!token) throw new Error('Server did not return a session token');
  return token;
}

// Permanently deletes the signed-in user's account + data on the server. The App
// Store and Google Play both require an in-app account-deletion path for apps
// with account creation. Returns true on success so the caller can sign out.
export async function deleteAccount(sessionToken: string): Promise<boolean> {
  try {
    const deviceId = await getDeviceId();
    const res = await fetch(`${SERVER_URL}/auth/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}`, 'x-device-id': deviceId },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function signOut(): Promise<void> {
  await clearAuth();
}
