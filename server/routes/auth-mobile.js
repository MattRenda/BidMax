import fetch from 'node-fetch';
import crypto from 'crypto';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SERVER_URL = process.env.SERVER_URL || 'https://bidmax-development.up.railway.app';
const CALLBACK_URL = `${SERVER_URL}/auth/google-mobile/callback`;
const STATE_SECRET = process.env.SESSION_SECRET || 'bidmax-state-secret';

function signState(data) {
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function verifyState(token) {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// GET /auth/google-mobile/start?returnUrl=bidmax://...
export async function mobileAuthStart(req, res) {
  const { returnUrl } = req.query;

  if (!returnUrl || !returnUrl.startsWith('bidmax://')) {
    return res.status(400).json({ error: 'Invalid returnUrl' });
  }

  const state = signState({ returnUrl, ts: Date.now() });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });

  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// GET /auth/google-mobile/callback?code=...&state=...
export async function mobileAuthCallback(req, res) {
  const { code, state: stateToken, error } = req.query;

  if (error) {
    return res.redirect(`bidmax://auth-callback?error=${encodeURIComponent(error)}`);
  }

  const stateData = verifyState(stateToken);
  if (!stateData) {
    return res.redirect(`bidmax://auth-callback?error=invalid_state`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.id_token) throw new Error('No id_token in response');

    // Get user info
    const userRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokens.id_token}`);
    const googleUser = await userRes.json();

    if (!googleUser.email) throw new Error('No email in token');

    // Mint BidMax session using existing auth logic
    const { findOrCreateUser, createSession } = await import('./auth.js');
    const user = await findOrCreateUser({
      googleId: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name,
    });
    const sessionToken = await createSession(user.id);

    return res.redirect(`${stateData.returnUrl}?sessionToken=${encodeURIComponent(sessionToken)}&email=${encodeURIComponent(user.email)}&isPro=${user.isPro}`);
  } catch (err) {
    console.error('Mobile auth callback error:', err.message);
    return res.redirect(`bidmax://auth-callback?error=${encodeURIComponent(err.message)}`);
  }
}
