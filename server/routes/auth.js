import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import appleSignin from 'apple-signin-auth';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const FREE_DAILY_LIMIT = 10;

// Normalize raw DB user row to consistent shape
function normalizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    googleId: user.google_id,
    is_pro: user.is_pro || false,
  };
}

// Verify Google token (handles both access tokens and ID tokens from chrome.identity)
async function verifyGoogleToken(token) {
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (userInfoRes.ok) {
    const info = await userInfoRes.json();
    if (!info.sub) throw new Error('Could not get user info from Google');
    return { googleId: info.sub, email: info.email, name: info.name };
  }
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (!res.ok) throw new Error('Invalid Google token');
  const payload = await res.json();
  if (payload.exp < Date.now() / 1000) throw new Error('Token expired');
  return { googleId: payload.sub, email: payload.email };
}

// ── Get or create user from Google ──
export async function upsertUser(googleId, email, referredBy = null) {
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('google_id', googleId)
    .single();
  if (!user) {
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (existing) {
      const { data: updated } = await supabase
        .from('users')
        .update({ google_id: googleId })
        .eq('id', existing.id)
        .select()
        .single();
      user = updated;
    } else {
      const insert = { google_id: googleId, email };
      if (referredBy) insert.referred_by = referredBy;
      const { data: created, error } = await supabase
        .from('users')
        .insert(insert)
        .select()
        .single();
      if (error) throw new Error('Failed to create user: ' + JSON.stringify(error));
      user = created;
    }
  }
  return user;
}

// ── Create session ──
export async function createSession(userId) {
  const { data: session, error } = await supabase
    .from('sessions')
    .insert({ user_id: userId })
    .select()
    .single();
  if (error) throw new Error('Failed to create session');
  return session;
}

// ── Validate session token — always returns normalized user with isPro ──
export async function validateSession(token) {
  if (!token) return null;
  const { data: session } = await supabase
    .from('sessions')
    .select('*, users(*)')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single();
  if (!session) return null;
  await supabase
    .from('sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', session.id);
  return normalizeUser(session.users);
}

// ── Check and increment usage ──
export async function checkAndIncrementUsage(deviceId, userId) {
  const today = new Date().toISOString().split('T')[0];
  if (userId) {
    const { data: user } = await supabase
      .from('users')
      .select('is_pro')
      .eq('id', userId)
      .single();
    if (user?.is_pro) {
      await supabase.rpc('increment_usage', { p_user_id: userId, p_device_id: null, p_date: today });
      return { allowed: true, isPro: true, used: null, limit: null };
    }
  }
  const { data: usage } = await supabase
    .from('usage')
    .select('batch_count')
    .eq('device_id', deviceId)
    .eq('date', today)
    .single();
  const current = usage?.batch_count || 0;
  if (current >= FREE_DAILY_LIMIT) {
    return { allowed: false, isPro: false, used: current, limit: FREE_DAILY_LIMIT };
  }
  await supabase
    .from('usage')
    .upsert({ device_id: deviceId, date: today, batch_count: current + 1 }, { onConflict: 'device_id,date' });
  return { allowed: true, isPro: false, used: current + 1, limit: FREE_DAILY_LIMIT };
}

// ── POST /auth/google ──
export async function googleAuth(req, res) {
  try {
    const { idToken, accessToken, ref } = req.body;
    const token = accessToken || idToken;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const { googleId, email } = await verifyGoogleToken(token);
    const user = await upsertUser(googleId, email, ref || null);
    const session = await createSession(user.id);
    res.json({
      token: session.token,
      user: normalizeUser(user),
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: err.message });
  }
}

// ── GET /auth/me ──
export async function getMe(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user = await validateSession(token);
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    const today = new Date().toISOString().split('T')[0];
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;
    let usedCount = 0;
    if (user.is_pro) {
      const { data: usage } = await supabase
        .from('usage').select('batch_count')
        .eq('user_id', user.id).eq('date', today).single();
      usedCount = usage?.batch_count || 0;
    } else if (deviceId) {
      const { data: usage } = await supabase
        .from('usage').select('batch_count')
        .eq('device_id', deviceId).eq('date', today).single();
      usedCount = usage?.batch_count || 0;
    }
    res.json({
      user,
      usage: { used: usedCount, limit: user.is_pro ? null : FREE_DAILY_LIMIT },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── DELETE /auth/me — permanently delete user account and all associated data ──
export async function deleteAccount(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;

    let userId = null;

    if (token) {
      const user = await validateSession(token);
      if (user) userId = user.id;
    }

    if (!userId && !deviceId) {
      return res.status(400).json({ error: 'No session or device ID provided' });
    }

    // Delete all user data — order matters for FK constraints
    if (userId) {
      await supabase.from('sessions').delete().eq('user_id', userId);
      await supabase.from('usage').delete().eq('user_id', userId);
      await supabase.from('location_requests').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }

    // Delete device usage rows regardless of auth
    if (deviceId) {
      await supabase.from('usage').delete().eq('device_id', deviceId);
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('[DeleteAccount] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
export async function logout(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      await supabase.from('sessions').delete().eq('token', token);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── findOrCreateUser (used by mobile auth) ──
export async function findOrCreateUser({ googleId, email, name }) {
  const user = await upsertUser(googleId, email);
  return normalizeUser(user);
}


export async function appleSignIn(req, res) {
  try {
    const { identityToken, fullName, email } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

    // Verify the JWT against Apple's JWKS
    let applePayload;
    try {
      applePayload = await appleSignin.verifyIdToken(identityToken, {
        audience: 'com.bidmax.app',
        ignoreExpiration: false,
      });
    } catch (e) {
      return res.status(401).json({ error: 'Invalid Apple identity token', detail: e.message });
    }

    const appleUserId = applePayload.sub;
    // Apple only sends email on first sign-in — fall back to payload email
    const userEmail = email || applePayload.email || `${appleUserId}@privaterelay.appleid.com`;
    // name column does not exist in users table — omit

    // Find existing user by apple_id or email
    let { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('apple_id', appleUserId)
      .maybeSingle();

    if (!existing) {
      // Try matching by email (user may have signed in with Google before)
      const { data: byEmail } = await supabase
        .from('users')
        .select('*')
        .eq('email', userEmail)
        .maybeSingle();

      if (byEmail) {
        // Link Apple ID to existing account
        await supabase
          .from('users')
          .update({ apple_id: appleUserId })
          .eq('id', byEmail.id);
        existing = { ...byEmail, apple_id: appleUserId };
      } else {
        // Create new user
        const { data: newUser, error } = await supabase
          .from('users')
          .insert({
            apple_id: appleUserId,
            email: userEmail,
            is_pro: false,
          })
          .select()
          .single();
        if (error) throw error;
        existing = newUser;
      }
    }

    // Create session
    const sessionToken = crypto.randomUUID();
    await supabase.from('sessions').insert({
      user_id: existing.id,
      token: sessionToken,
    });

    const user = normalizeUser(existing);
    return res.json({ sessionToken, user });
  } catch (e) {
    console.error('[Auth] Apple sign-in error:', e);
    return res.status(500).json({ error: e.message });
  }
}
