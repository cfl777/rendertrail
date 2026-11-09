import { useEffect, useState } from 'react';
import { quoteShipping, type CartItem } from './data';

// Deliberately slow (about 0.3 ms per render) so the extra update costs real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

function useShippingQuote(total: number) {
  const [quote, setQuote] = useState<number | null>(null);
  useEffect(() => {
    let ignore = false;
    quoteShipping(total).then((value) => {
      if (!ignore) setQuote(value);
    });
    return () => {
      ignore = true;
    };
  }, [total]);
  return quote;
}

export function CartSummary({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = useShippingQuote(total);

  busyWait(0.3);
  return (
    <aside>
      <p>Total: {total.toFixed(2)} EUR</p>
      <p>Shipping: {shipping === null ? '…' : `${shipping.toFixed(2)} EUR`}</p>
    </aside>
  );
}
