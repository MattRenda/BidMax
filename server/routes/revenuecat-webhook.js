import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRO_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'NON_RENEWING_PURCHASE',
]);

export async function handleRevenueCatWebhook(req, res) {
  // Verify webhook secret
  if (req.headers.authorization !== process.env.REVENUECAT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body?.event;
  if (!event) return res.status(200).json({ ok: true, skipped: 'no event' });

  const { type, app_user_id, entitlement_ids } = event;
  const hasPro = Array.isArray(entitlement_ids) && entitlement_ids.includes('BidMax Pro');

  try {
    if (PRO_EVENTS.has(type) && hasPro) {
      await supabase
        .from('users')
        .update({ is_pro: true })
        .eq('id', app_user_id);
      console.log(`[RevenueCat] ${type} → user ${app_user_id} set Pro`);
    } else if (type === 'EXPIRATION') {
      await supabase
        .from('users')
        .update({ is_pro: false })
        .eq('id', app_user_id);
      console.log(`[RevenueCat] EXPIRATION → user ${app_user_id} revoked Pro`);
    } else {
      console.log(`[RevenueCat] Ignored event type: ${type}`);
    }
  } catch(e) {
    console.error('[RevenueCat] DB error:', e.message);
  }

  return res.status(200).json({ ok: true });
}
