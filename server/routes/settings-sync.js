import { createClient } from '@supabase/supabase-js';
import { validateSession } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// POST /api/settings — client syncs the user's settings up so the server can
// compute fire deals. Body: { sessionToken, targetMargin, buyersPremium,
// fireThreshold, emailFireAlerts }
export async function syncSettings(req, res) {
  try {
    const { sessionToken, targetMargin, buyersPremium, fireThreshold, emailFireAlerts } = req.body || {};
    const user = sessionToken ? await validateSession(sessionToken) : null;
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
