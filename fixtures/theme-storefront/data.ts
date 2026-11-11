import { createContext } from 'react';

export type Theme = 'light' | 'dark';
export type Product = { id: number; name: string; price: number };

export const ThemeContext = createContext<Theme>('light');

// 40 products with deterministic names and prices.
export const PRODUCTS: Product[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: 10 + ((i * 7) % 50),
}));
