# Try the card in Claude Desktop

1. Quit Claude Desktop fully (tray icon → Quit) and start it again, so it loads the rebuilt server.
2. Open a new chat and paste everything below the line. Claude should call the rendertrail tool and the card should appear in the chat.
3. If no card appears, check %LOCALAPPDATA%ClaudeLogsmcp-server-rendertrail.log for the handshake.

---

Use the rendertrail inspect_render tool on this React component. Entry file SearchPage.tsx, default export. Steps: type "hello" into input[aria-label="Search"] with 100 ms between letters, then wait 600 ms. Send these files exactly as given:

File SearchPage.tsx:
```tsx
import { useState } from 'react';
import { useDebounce, useResults } from './hooks';
import { Header, Layout, Sidebar } from './ui';
import { SearchBox } from './SearchBox';
import { ResultsList } from './ResultsList';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query, 300);
  const results = useResults(debounced);
  const [tags] = useState(['react']);

  return (
    <Layout>
      <Header />
      <SearchBox value={query} onChange={setQuery} />
      <ResultsList
        items={results}
        filters={{ sort: 'recent', tags }}
      />
      <Sidebar tags={tags} />
    </Layout>
  );
}
```

File SearchBox.tsx:
```tsx
import { useEffect, useState } from 'react';

type SearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
};

export function SearchBox({ value, onChange }: SearchBoxProps) {
  const [charCount, setCharCount] = useState(0);
  useEffect(() => setCharCount(value.length), [value]);

  return (
    <div>
      <input
        aria-label="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{charCount} characters</small>
    </div>
  );
}
```

File ResultsList.tsx:
```tsx
import { memo } from 'react';
import { ResultRow } from './ResultRow';
import type { Filters, Result } from './data';

type ResultsListProps = {
  items: Result[];
  filters: Filters;
};

export const ResultsList = memo(function ResultsList({ items, filters }: ResultsListProps) {
  const visible = filters.sort === 'recent' ? [...items].reverse() : items;

  return (
    <ul aria-label={`Results tagged ${filters.tags.join(', ')}`}>
      {visible.map((item) => (
        <ResultRow key={item.id} item={item} />
      ))}
    </ul>
  );
});
```

File ResultRow.tsx:
```tsx
import type { Result } from './data';

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
```

File data.ts:
```tsx
export type Result = { id: number; title: string };
export type Filters = { sort: 'recent' | 'relevance'; tags: string[] };

const TOPICS = ['hello world in React', 'memo and props', 'effects and state', 'keys and lists'];

// 200 results; 50 of them match "hello".
export const RESULTS: Result[] = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1,
  title: `${TOPICS[i % TOPICS.length]} #${i + 1}`,
}));
```

File hooks.ts:
```tsx
import { useEffect, useMemo, useState } from 'react';
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
```

File ui.tsx:
```tsx
import { memo, type ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return <main>{children}</main>;
}

export function Header() {
  return <h1>Search</h1>;
}

export const Sidebar = memo(function Sidebar({ tags }: { tags: string[] }) {
  return (
    <aside>
      {tags.map((tag) => (
        <span key={tag}>#{tag}</span>
      ))}
    </aside>
  );
});
```

After the result, tell me in one line what the card shows.
