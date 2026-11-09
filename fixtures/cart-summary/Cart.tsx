import { useState } from 'react';
import { INITIAL_CART, type CartItem } from './data';
import { CartSummary } from './CartSummary';

function CartLine({ item, onChange }: { item: CartItem; onChange: (id: string, delta: number) => void }) {
  return (
    <li>
      {item.name} × {item.qty}
      <button aria-label={`Remove one ${item.name}`} onClick={() => onChange(item.id, -1)}>−</button>
      <button aria-label={`Add one ${item.name}`} onClick={() => onChange(item.id, 1)}>+</button>
    </li>
  );
}

export default function Cart() {
  const [items, setItems] = useState(INITIAL_CART);

  function handleChange(id: string, delta: number) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, qty: Math.max(0, item.qty + delta) } : item)),
    );
  }

  return (
    <main>
      <ul>
        {items.map((item) => (
          <CartLine key={item.id} item={item} onChange={handleChange} />
        ))}
      </ul>
      <CartSummary items={items} />
    </main>
  );
}
