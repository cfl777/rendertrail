import { memo } from 'react'; // Copied from fixtures/laggy-search/ResultsList.tsx (test/example.test.ts keeps them the same).
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
