import Stripe from 'stripe';
import { config } from '../config.js';

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(config.stripe.secretKey || 'sk_test_placeholder', {
      apiVersion: '2025-02-24.acacia',
    });
  }
  return _stripe;
}

export const PLANS = {
  pro: {
    name: 'STRATEMARK Pro',
    price: 2900,
    interval: 'month' as const,
    companies: 10,
  },
  team: {
    name: 'STRATEMARK Team',
    price: 7900,
    interval: 'month' as const,
    companies: 25,
  },
  enterprise: {
    name: 'STRATEMARK Enterprise',
    price: 19900,
    interval: 'month' as const,
    companies: 100,
  },
} as const;

export type PlanTier = keyof typeof PLANS;

export async function createCheckoutSession(
  tier: PlanTier,
  userEmail: string,
  userId: string,
): Promise<string> {
  const plan = PLANS[tier];

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    customer_email: userEmail,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: plan.name },
          unit_amount: plan.price,
          recurring: { interval: plan.interval },
        },
        quantity: 1,
      },
    ],
    success_url: `${config.app.url}/dashboard?upgraded=true`,
    cancel_url: `${config.app.url}/pricing`,
    metadata: { userId, tier },
  });

  return session.url ?? '';
}

export async function createPortalSession(stripeCustomerId: string): Promise<string> {
  const session = await getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${config.app.url}/dashboard`,
  });

  return session.url;
}
