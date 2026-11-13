import { useEffect, useState } from 'react'; // Same as fixtures/laggy-search/SearchBox.tsx in the Rendertrail repo (a test there keeps the two the same).

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
