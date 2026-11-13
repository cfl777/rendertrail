import { useState } from 'react'; // Copied from fixtures/laggy-search/SearchPage.tsx (test/example.test.ts keeps them the same).
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
