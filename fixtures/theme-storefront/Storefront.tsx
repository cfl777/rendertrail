import { useState } from 'react';
import { PRODUCTS, ThemeContext, type Theme } from './data';
import { ProductGrid, PromoBanner } from './ProductGrid';

export default function Storefront() {
  const [theme, setTheme] = useState<Theme>('light');

  return (
    <ThemeContext.Provider value={theme}>
      <button
        aria-label="Toggle theme"
        onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      >
        {theme === 'light' ? 'Dark mode' : 'Light mode'}
      </button>
      <PromoBanner text="Free shipping over 50 EUR" />
      <ProductGrid products={PRODUCTS} layout={{ columns: 4, gap: 12 }} />
    </ThemeContext.Provider>
  );
}
