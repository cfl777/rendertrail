import { useEffect, useState } from 'react'; // Copied from fixtures/laggy-search/SearchBox.tsx (test/example.test.ts keeps them the same).

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
