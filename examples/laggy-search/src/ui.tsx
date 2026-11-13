import { memo, type ReactNode } from 'react'; // Copied from fixtures/laggy-search/ui.tsx (test/example.test.ts keeps them the same).

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
