import { useState, type FormEvent } from 'react';
import { TODOS } from './data';
import { TodoFooter, TodoItem } from './TodoItem';

export default function TodoApp() {
  const [todos, setTodos] = useState(TODOS);
  const [draft, setDraft] = useState('');

  function handleToggle(id: number) {
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  }

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    setTodos((prev) => [...prev, { id: prev.length + 1, title: draft, done: false }]);
    setDraft('');
  }

  const remaining = todos.filter((t) => !t.done).length;

  return (
    <section>
      <form onSubmit={handleAdd}>
        <input aria-label="New todo" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((todo) => (
          <TodoItem key={todo.id} todo={todo} onToggle={handleToggle} />
        ))}
      </ul>
      <TodoFooter remaining={remaining} />
    </section>
  );
}
