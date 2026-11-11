export type Billing = 'monthly' | 'yearly';
export type Plan = { id: string; name: string; monthly: number };
export type Feature = { id: number; name: string; plans: string[] };
export type Labels = { included: string; missing: string };

export const PLANS: Plan[] = [
  { id: 'solo', name: 'Solo', monthly: 18 },
  { id: 'team', name: 'Team', monthly: 79 },
  { id: 'studio', name: 'Studio', monthly: 149 },
];

// 80 features; each is in Studio, two thirds are in Team, one third in Solo.
export const FEATURES: Feature[] = Array.from({ length: 80 }, (_, i) => ({
  id: i + 1,
  name: `Feature ${i + 1}`,
  plans: ['studio', ...(i % 3 !== 0 ? ['team'] : []), ...(i % 3 === 2 ? ['solo'] : [])],
}));

export function priceFor(monthly: number, billing: Billing, discount: number): number {
  const base = billing === 'yearly' ? monthly * 12 : monthly;
  return Math.round(base * (1 - discount));
}
