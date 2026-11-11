import { memo } from 'react';
import type { Todo } from './data';

// Deliberately slow (about 0.05 ms per item, about 0.1 ms with timer rounding) so wasted renders cost real time.
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // do nothing
  }
}

type TodoItemProps = {
  todo: Todo;
  onToggle: (id: number) => void;
};

export const TodoItem = memo(function TodoItem({ todo, onToggle }: TodoItemProps) {
  busyWait(0.05);
  return (
    <li>
      <input
        type="checkbox"
        aria-label={`Toggle ${todo.title}`}
        checked={todo.done}
        onChange={() => onToggle(todo.id)}
      />
      {todo.title}
    </li>
  );
});

export const TodoFooter = memo(function TodoFooter({ remaining }: { remaining: number }) {
  return <footer>{remaining} left</footer>;
});
