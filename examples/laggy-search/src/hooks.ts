import { useEffect, useMemo, useState } from 'react'; // Same as fixtures/laggy-search/hooks.ts in the Rendertrail repo (a test there keeps the two the same).
import { RESULTS, type Result } from './data';

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

export function useResults(query: string): Result[] {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return RESULTS.filter((result) => result.title.toLowerCase().includes(q));
  }, [query]);
}
