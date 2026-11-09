import { useMemo, useState } from 'react';
import { useDebounce, useResults } from './hooks';
import { Header, Layout, Sidebar } from './ui';
import { SearchBox } from './SearchBox';
import { ResultsList } from './ResultsList';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query, 300);
  const results = useResults(debounced);
  const [tags] = useState(['react']);
  const filters = useMemo(() => ({ sort: 'recent' as const, tags }), [tags]);

  return (
    <Layout>
      <Header />
      <SearchBox value={query} onChange={setQuery} />
      <ResultsList
        items={results}
        filters={filters}
      />
      <Sidebar tags={tags} />
    </Layout>
  );
}
