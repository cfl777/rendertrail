export type Todo = { id: number; title: string; done: boolean };

// 100 todos; every fourth one starts done, so 75 are open.
export const TODOS: Todo[] = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  title: `Task ${i + 1}`,
  done: i % 4 === 0,
}));
