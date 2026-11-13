import type { Result } from './data'; // Copied from fixtures/laggy-search/ResultRow.tsx (test/example.test.ts keeps them the same).

// Deliberately slow (about 0.06 ms per row) so wasted renders cost real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

export function ResultRow({ item }: { item: Result }) {
  busyWait(0.06);
  return <li>{item.title}</li>;
}
