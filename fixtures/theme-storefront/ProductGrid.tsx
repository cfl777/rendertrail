import { memo, useContext } from 'react';
import { ThemeContext, type Product } from './data';

// Deliberately slow (about 0.1 ms per card) so the renders cost real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

export const ProductCard = memo(function ProductCard({ product }: { product: Product }) {
  const theme = useContext(ThemeContext);
  busyWait(0.1);
  return (
    <li data-theme={theme}>
      {product.name}: {product.price} EUR
    </li>
  );
});

type Layout = { columns: number; gap: number };

export const ProductGrid = memo(function ProductGrid({ products, layout }: { products: Product[]; layout: Layout }) {
  const theme = useContext(ThemeContext);
  return (
    <ul data-theme={theme} data-columns={layout.columns} data-gap={layout.gap}>
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </ul>
  );
});

export const PromoBanner = memo(function PromoBanner({ text }: { text: string }) {
  return <p>{text}</p>;
});
