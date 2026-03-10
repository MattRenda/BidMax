import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { validateSession } from './auth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRICE_ID = process.env.STRIPE_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const APP_URL = process.env.APP_URL || 'https://bidmaxapp.com';

// ── POST /billing/checkout ──
export async function createCheckout(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user = await validateSession(token);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await supabase
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://bidmax-production.up.railway.app/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}?cancelled=true`,
      metadata: { userId: user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /billing/portal ──
export async function createPortal(req, res) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const user = await validateSession(token);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: APP_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /billing/webhook ──
export async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (userId) {
          await supabase
            .from('users')
            .update({ is_pro: true, pro_since: new Date().toISOString() })
            .eq('id', userId);
          console.log(`User ${userId} upgraded to Pro`);
        }
        break;
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.paused': {
        const sub = event.data.object;
        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('stripe_customer_id', sub.customer)
          .single();
        if (user) {
          await supabase
            .from('users')
            .update({ is_pro: false, pro_until: new Date().toISOString() })
            .eq('id', user.id);
          console.log(`User ${user.id} downgraded from Pro`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log(`Payment failed for customer ${invoice.customer}`);
        // Could send email via Resend here
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
