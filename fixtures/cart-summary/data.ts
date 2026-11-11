export type CartItem = { id: string; name: string; price: number; qty: number };

export const INITIAL_CART: CartItem[] = [
  { id: 'mat', name: 'Yoga mat', price: 39.0, qty: 1 },
  { id: 'roller', name: 'Foam roller', price: 24.5, qty: 2 },
  { id: 'band', name: 'Resistance band', price: 12.0, qty: 1 },
];

// Stands in for a shipping API: 5 % of the total, rounded to cents. No network.
export function quoteShipping(total: number): Promise<number> {
  return Promise.resolve(Math.round(total * 5) / 100);
}
