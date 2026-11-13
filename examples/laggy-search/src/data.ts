export type Result = { id: number; title: string }; // Copied from fixtures/laggy-search/data.ts (test/example.test.ts keeps them the same).
export type Filters = { sort: 'recent' | 'relevance'; tags: string[] };

const TOPICS = ['hello world in React', 'memo and props', 'effects and state', 'keys and lists'];

// 200 results; 50 of them match "hello".
export const RESULTS: Result[] = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1,
  title: `${TOPICS[i % TOPICS.length]} #${i + 1}`,
}));
