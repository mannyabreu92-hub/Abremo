// Monetization: free for artists to start, Pro tools, and a 5–10% marketplace commission.

export const PLANS = Object.freeze([
  {
    id: 'free',
    name: 'Free',
    price: 0,
    features: ['Upload art', 'Basic rankings', 'Unlimited swiping', 'Art Battles'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 7.99,
    features: ['Everything in Free', 'Analytics dashboard', 'See who liked your work', 'Sales insights'],
  },
  {
    id: 'studio',
    name: 'Studio',
    price: 19.99,
    features: ['Everything in Pro', 'Promotion tools', 'Portfolio website', 'Priority in Art Battles queue'],
  },
]);

/** Sliding commission: 10% under $1k, 7.5% under $10k, 5% above. */
export function commissionRate(price) {
  if (price < 1000) return 0.1;
  if (price < 10000) return 0.075;
  return 0.05;
}

export function checkoutBreakdown(price) {
  const rate = commissionRate(price);
  const fee = Math.round(price * rate * 100) / 100;
  return { price, rate, fee, artistPayout: Math.round((price - fee) * 100) / 100 };
}

export function hasFeature(planId, feature) {
  const plan = PLANS.find((p) => p.id === planId) || PLANS[0];
  const order = PLANS.map((p) => p.id);
  const need = { analytics: 'pro', whoLiked: 'pro', salesInsights: 'pro', promotion: 'studio', portfolio: 'studio' }[feature];
  if (!need) return true;
  return order.indexOf(plan.id) >= order.indexOf(need);
}
