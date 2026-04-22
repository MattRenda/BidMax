import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const FREE_DAILY_LIMIT = 10;

// Verify Google token (handles both access tokens and ID tokens from chrome.identity)
async function verifyGoogleToken(token) {
  // Try as access token first (what chrome.identity.getAuthToken returns)
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (userInfoRes.ok) {
    const info = await userInfoRes.json();
    if (!info.sub) throw new Error('Could not get user info from Google');
    return { googleId: info.sub, email: info.email, name: info.name };
  }

  // Fall back to ID token verification
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (!res.ok) throw new Error('Invalid Google token');
  const payload = await res.json();
  if (payload.exp < Date.now() / 1000) throw new Error('Token expired');
  return { googleId: payload.sub, email: payload.email };
}

// ── Get or create user from Google ──
async function upsertUser(googleId, email) {
  // Check if user exists by google_id
  let { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('google_id', googleId)
    .single();

  if (!user) {
    // Check by email (in case they signed up another way)
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existing) {
      // Link google_id to existing account
      const { data: updated } = await supabase
        .from('users')
        .update({ google_id: googleId })
        .eq('id', existing.id)
        .select()
        .single();
      user = updated;
    } else {
      // Create new user
      const { data: created, error } = await supabase
        .from('users')
        .insert({ google_id: googleId, email })
        .select()
        .single();
      if (error) throw new Error('Failed to create user: ' + error.message);
      user = created;
    }
  }

  return user;
}

// ── Create session ──
async function createSession(userId) {
  const { data: session, error } = await supabase
    .from('sessions')
    .insert({ user_id: userId })
    .select()
    .single();
  if (error) throw new Error('Failed to create session');
  return session;
}

// ── Validate session token ──
export async function validateSession(token) {
  if (!token) return null;
  const { data: session } = await supabase
    .from('sessions')
    .select('*, users(*)')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single();
  if (!session) return null;

  // Update last_used_at
  await supabase
    .from('sessions')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', session.id);

  return session.users;
}

// ── Check and increment usage ──
export async function checkAndIncrementUsage(deviceId, userId) {
  const today = new Date().toISOString().split('T')[0];

  // Pro users have unlimited access
  if (userId) {
    const { data: user } = await supabase
      .from('users')
      .select('is_pro')
      .eq('id', userId)
      .single();
    if (user?.is_pro) {
      // Still track usage for pro users (by user_id)
      await supabase.rpc('increment_usage', { p_user_id: userId, p_device_id: null, p_date: today });
      return { allowed: true, isPro: true, used: null, limit: null };
    }
  }

  // Free users: check device_id limit
  const lookupKey = deviceId;
  const { data: usage } = await supabase
    .from('usage')
    .select('batch_count')
    .eq('device_id', lookupKey)
    .eq('date', today)
    .single();

  const current = usage?.batch_count || 0;
  if (current >= FREE_DAILY_LIMIT) {
    return { allowed: false, isPro: false, used: current, limit: FREE_DAILY_LIMIT };
  }

  // Increment
  await supabase
    .from('usage')
    .upsert({ device_id: lookupKey, date: today, batch_count: current + 1 }, { onConflict: 'device_id,date' });

  return { allowed: true, isPro: false, used: current + 1, limit: FREE_DAILY_LIMIT };
}

// ── POST /auth/google ──
export async function googleAuth(req, res) {
  try {
    const { idToken, accessToken } = req.body;
    const token = accessToken || idToken;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const { googleId, email } = await verifyGoogleToken(token);
    const user = await upsertUser(googleId, email);
    const session = await createSession(user.id);

    res.json({
      token: session.token,
      user: { id: user.id, email: user.email, isPro: user.is_pro }
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
      user: { id: user.id, email: user.email, isPro: user.is_pro },
      usage: { used: usedCount, limit: user.is_pro ? null : FREE_DAILY_LIMIT },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /auth/logout ──
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
