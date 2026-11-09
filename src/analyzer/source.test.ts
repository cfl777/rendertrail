import { describe, expect, it } from 'vitest';
import { confirmStateInEffect, dependenciesOf, findFunctions, findJsxProp, listHooks, parseFiles, reachableFrom } from './source.js';
import { laggyFiles } from './testing.js';

const parse = (files: Record<string, string>) => parseFiles(Object.entries(files).map(([path, content]) => ({ path, content })));

describe('listHooks', () => {
  it('lists the hooks in call order, expanding custom hooks from the files', () => {
    const files = reachableFrom(parseFiles(laggyFiles()), 'SearchPage.tsx');
    const found = findFunctions(files, 'SearchPage')[0]!;
    const hooks = listHooks(files, found.file, found.fn);
    expect(hooks.map((h) => [h.name, h.index, h.owner.name, h.setter])).toEqual([
      ['useState', 0, 'SearchPage', 'setQuery'],
      ['useState', 1, 'useDebounce', 'setDebounced'],
      ['useEffect', 2, 'useDebounce', null],
      ['useMemo', 3, 'useResults', null],
      ['useState', 4, 'SearchPage', null],
    ]);
  });

  it('skips useContext and marks indexes unknown after a hook it cannot see', () => {
    const files = parse({
      'A.tsx': [
        "import { useContext, useState } from 'react';",
        "import { useLib } from 'lib';",
        'export function A() {',
        '  const theme = useContext(Theme);',
        '  const [a, setA] = useState(0);',
        '  useLib();',
        '  const [b, setB] = useState(0);',
        '  return null;',
        '}',
      ].join('\n'),
    });
    const found = findFunctions(files, 'A')[0]!;
    expect(listHooks(files, found.file, found.fn).map((h) => [h.setter, h.index])).toEqual([
      ['setA', 0],
      ['setB', null],
    ]);
  });
});

describe('confirmStateInEffect', () => {
  const files = reachableFrom(parseFiles(laggyFiles()), 'SearchPage.tsx');

  it('confirms SearchBox: setCharCount is called synchronously in useEffect', () => {
    const found = confirmStateInEffect(files, 'SearchBox', 0);
    expect(found).toMatchObject({ state: 'charCount', setter: 'setCharCount', owner: 'SearchBox', effect: 'useEffect', matchedByIndex: true });
    expect(found?.file.path).toBe('SearchBox.tsx');
  });

  it('does not flag useDebounce: its setter runs inside setTimeout', () => {
    expect(confirmStateInEffect(files, 'SearchPage', 1)).toBeNull();
  });

  it('does not flag setters inside .then, handlers or timers, and flags a direct call in a block body', () => {
    const src = parse({
      'B.tsx': [
        "import { useEffect, useLayoutEffect, useState } from 'react';",
        'export function B({ v }: { v: number }) {',
        '  const [a, setA] = useState(0);',
        '  const [b, setB] = useState(0);',
        '  const [c, setC] = useState(0);',
        '  const [d, setD] = useState(0);',
        '  useEffect(() => { fetchIt().then((x) => setA(x)); }, []);',
        "  useEffect(() => { const h = () => setB(1); window.addEventListener('resize', h); }, []);",
        '  useEffect(() => { requestAnimationFrame(() => setC(2)); }, []);',
        '  useLayoutEffect(() => { if (v > 0) { setD(v * 2); } }, [v]);',
        '  return null;',
        '}',
      ].join('\n'),
    });
    expect(confirmStateInEffect(src, 'B', 0)).toBeNull();
    expect(confirmStateInEffect(src, 'B', 1)).toBeNull();
    expect(confirmStateInEffect(src, 'B', 2)).toBeNull();
    expect(confirmStateInEffect(src, 'B', 3)).toMatchObject({ setter: 'setD', effect: 'useLayoutEffect' });
  });

  it('falls back to the only synchronous setter when the hook index is ambiguous', () => {
    const src = parse({
      'C.tsx': [
        "import { useEffect, useState } from 'react';",
        "import { useLib } from 'lib';",
        'export function C({ v }: { v: string }) {',
        '  useLib();',
        '  const [n, setN] = useState(0);',
        '  const [m, setM] = useState(0);',
        '  useEffect(() => setN(v.length), [v]);',
        '  return <button onClick={() => setM(1)}>{n + m}</button>;',
        '}',
      ].join('\n'),
    });
    expect(confirmStateInEffect(src, 'C', 7)).toMatchObject({ setter: 'setN', matchedByIndex: false });
  });

  it('follows the state into a custom hook defined in the files', () => {
    const src = parse({
      'hooks.ts': [
        "import { useEffect, useState } from 'react';",
        'export function useLength(v: string) {',
        '  const [len, setLen] = useState(0);',
        '  useEffect(() => { setLen(v.length); }, [v]);',
        '  return len;',
        '}',
      ].join('\n'),
      'D.tsx': [
        "import { useState } from 'react';",
        "import { useLength } from './hooks';",
        "export function D() { const [v] = useState(''); const len = useLength(v); return <p>{len}</p>; }",
      ].join('\n'),
    });
    expect(confirmStateInEffect(src, 'D', 1)).toMatchObject({ setter: 'setLen', owner: 'useLength', state: 'len' });
  });
});

describe('findJsxProp', () => {
  it('finds the attribute line in the component that creates the element, not the fiber parent', () => {
    const files = reachableFrom(parseFiles(laggyFiles()), 'SearchPage.tsx');
    const [match, ...rest] = findJsxProp(files, 'ResultsList', 'filters');
    expect(rest).toEqual([]);
    expect(match).toMatchObject({ line: 19, valueKind: 'inline-object', snippet: "filters={{ sort: 'recent', tags }}" });
    expect(match?.file.path).toBe('SearchPage.tsx');
    expect(match?.enclosing).toEqual(['SearchPage']);
    expect(dependenciesOf(match!.valueExpression!)).toEqual(['tags']);
  });

  it('classifies local, memoized and passed-through values', () => {
    const files = parse({
      'E.tsx': [
        "import { useCallback, useMemo } from 'react';",
        'export function E({ onPick, items }: Props) {',
        "  const style = { color: 'red' };",
        '  const handle = () => onPick(1);',
        '  const memoed = useMemo(() => ({ a: 1 }), []);',
        '  const cb = useCallback(() => onPick(2), [onPick]);',
        '  function named() { return 1; }',
        '  return (',
        '    <Row style={style} onA={handle} m={memoed} onB={cb} onC={named} onD={onPick} onE={() => onPick(3)} items={items.filter(Boolean)} />',
        '  );',
        '}',
      ].join('\n'),
    });
    const kind = (prop: string) => findJsxProp(files, 'Row', prop)[0]?.valueKind;
    expect(kind('style')).toBe('local-object');
    expect(kind('onA')).toBe('local-function');
    expect(kind('m')).toBe('memoized');
    expect(kind('onB')).toBe('memoized');
    expect(kind('onC')).toBe('local-function');
    expect(kind('onD')).toBe('prop');
    expect(kind('onE')).toBe('inline-function');
    expect(kind('items')).toBe('other');
  });

  it('keeps only files the entry imports', () => {
    const files = reachableFrom(parseFiles(laggyFiles()), 'SearchPage.fixed.tsx');
    expect(files.map((f) => f.path).sort()).toEqual([
      'ResultRow.tsx',
      'ResultsList.tsx',
      'SearchBox.tsx',
      'SearchPage.fixed.tsx',
      'data.ts',
      'hooks.ts',
      'ui.tsx',
    ]);
  });
});
