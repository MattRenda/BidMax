import { createClient } from '@supabase/supabase-js';
import { validateSession } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const FREE_DAILY_LIMIT = 10;

// POST /api/settings — client syncs the user's settings up so the server can
// compute fire deals. Body: { sessionToken, targetMargin, buyersPremium,
// fireThreshold, emailFireAlerts }
export async function syncSettings(req, res) {
  try {
    // Read the token the SAME way the rest of the API does: Authorization
    // header first (Bearer ...), with body/query as fallbacks.
    const token = req.headers.authorization?.replace('Bearer ', '')
      || req.body?.sessionToken
      || req.query?.sessionToken;
    const { targetMargin, buyersPremium, fireThreshold, emailFireAlerts } = req.body || {};
    const user = token ? await validateSession(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Clamp to sane ranges (defend against bad client input)
    const tm = Math.min(500, Math.max(0, parseInt(targetMargin) || 30));
    const bp = Math.min(100, Math.max(0, parseInt(buyersPremium) || 15));
    const ft = Math.min(100000, Math.max(0, parseInt(fireThreshold) || 50));

    await supabase.from('user_settings').upsert({
      user_id: user.id,
      target_margin: tm,
      buyers_premium: bp,
      fire_threshold: ft,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    // Email opt-in lives on the users row (only update if provided)
    if (typeof emailFireAlerts === 'boolean') {
      await supabase.from('users').update({ email_fire_alerts: emailFireAlerts }).eq('id', user.id);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[Settings] sync error:', e.message);
    res.status(500).json({ error: 'Sync failed' });
  }
}

// POST /api/push-token — store a device's Expo push token for fire-deal alerts.
export async function savePushToken(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body?.sessionToken;
    const pushToken = req.body?.token;
    const user = token ? await validateSession(token) : null;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (typeof pushToken !== 'string' || !pushToken.startsWith('ExponentPushToken')) {
      return res.status(400).json({ error: 'Invalid push token' });
    }
    await supabase.from('users').update({ expo_push_token: pushToken }).eq('id', user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Push] save token error:', e.message);
    res.status(500).json({ error: 'Failed to save token' });
  }
}

// GET /api/usage — read-only daily analysis usage {used, limit} for the current
// device (or session). Lets anonymous free users see their true count on app
// open; previously only a reveal (which sends the device id) returned it.
export async function getUsageStatus(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.sessionToken;
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;

    // Pro users are unlimited regardless of device.
    if (token) {
      const user = await validateSession(token);
      if (user?.is_pro) return res.json({ used: 0, limit: null });
    }
    // Free usage is tracked by device id (the same key checkAndIncrementUsage writes).
    if (deviceId) {
      const { data } = await supabase.from('usage').select('batch_count')
        .eq('device_id', deviceId).eq('date', today).maybeSingle();
      return res.json({ used: data?.batch_count || 0, limit: FREE_DAILY_LIMIT });
    }
    return res.json({ used: 0, limit: FREE_DAILY_LIMIT });
  } catch (e) {
    console.error('[Usage] status error:', e.message);
    res.status(500).json({ error: 'Failed to read usage' });
  }
}

// GET /unsubscribe?u=USER_ID — one-click unsubscribe from fire-deal emails.
// CAN-SPAM requires this to work without login.
export async function unsubscribe(req, res) {
  try {
    const userId = req.query.u;
    if (!userId) return res.status(400).send('Missing user.');
    await supabase.from('users').update({ email_fire_alerts: false }).eq('id', userId);
    res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;">
        <h2>Unsubscribed</h2>
        <p>You will no longer receive Fire Deal alert emails from BidMax.</p>
        <p>You can re-enable them anytime in the BidMax app settings.</p>
      </div>`);
  } catch (e) {
    console.error('[Settings] unsubscribe error:', e.message);
    res.status(500).send('Something went wrong. Please try again.');
  }
}
