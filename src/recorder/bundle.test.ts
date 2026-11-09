import { describe, expect, it } from 'vitest';
import { bundleApp, findAliased, findFile, namedImportsOf, normalizePath } from './bundle.js';

describe('normalizePath / findFile', () => {
  it('normalizes separators and leading ./ or /', () => {
    expect(normalizePath('./src\\a/../b.tsx')).toBe('src/b.tsx');
    expect(normalizePath('/x.ts')).toBe('x.ts');
  });

  it('finds files by extension and folder index', () => {
    const files = new Map([
      ['a.tsx', ''],
      ['lib/index.ts', ''],
    ]);
    expect(findFile(files, 'a')).toBe('a.tsx');
    expect(findFile(files, './lib')).toBe('lib/index.ts');
    expect(findFile(files, 'nope')).toBeUndefined();
  });
});

describe('findFile with .js imports and findAliased', () => {
  const files = new Map([
    ['src/components/Button.tsx', ''],
    ['lib/util.ts', ''],
    ['hooks.ts', ''],
  ]);

  it('maps .js, .jsx and .mjs imports to the .ts/.tsx source', () => {
    expect(findFile(files, 'lib/util.js')).toBe('lib/util.ts');
    expect(findFile(files, 'src/components/Button.jsx')).toBe('src/components/Button.tsx');
    expect(findFile(files, 'hooks.mjs')).toBe('hooks.ts');
  });

  it('resolves @/ and ~/ aliases with and without a src/ prefix', () => {
    expect(findAliased(files, '@/components/Button')).toBe('src/components/Button.tsx');
    expect(findAliased(files, '~/src/components/Button')).toBe('src/components/Button.tsx');
    expect(findAliased(files, '@/lib/util')).toBe('lib/util.ts');
    expect(findAliased(files, '@/src/lib/util')).toBe('lib/util.ts');
    expect(findAliased(files, '@/nope')).toBeUndefined();
    expect(findAliased(files, '@scope/pkg')).toBeUndefined();
  });

  it('bundles an aliased import instead of stubbing it', async () => {
    const result = await bundleApp({
      files: [
        { path: 'src/App.tsx', content: `import { label } from '@/text.js';
export default function App() { return <p>{label}</p>; }` },
        { path: 'src/text.ts', content: `export const label = 'hi';` },
      ],
      entry: 'src/App.tsx',
      exportName: 'default',
    });
    expect(result.ok && result.stubs).toEqual([]);
  });
});

describe('namedImportsOf', () => {
  it('collects named imports and re-exports of one module', () => {
    const sources = [
      `import Thing, { useA, type B, c as d } from 'lib';\nimport { other } from 'other';`,
      `export { useE } from "lib";\nimport * as ns from 'lib';`,
    ];
    expect(namedImportsOf('lib', sources)).toEqual(['B', 'c', 'useA', 'useE']);
  });
});

describe('bundleApp', () => {
  it('bundles in-memory files, stubs unknown imports and ignores CSS', async () => {
    const result = await bundleApp({
      files: [
        {
          path: 'App.tsx',
          content: [
            `import { Button } from '@ui/kit';`,
            `import './app.css';`,
            `import { label } from './text';`,
            `export default function App() { return <Button>{label}</Button>; }`,
          ].join('\n'),
        },
        { path: 'text.ts', content: `export const label = 'hi';` },
      ],
      entry: 'App.tsx',
      exportName: 'default',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stubs).toEqual(['@ui/kit (imported by App.tsx)']);
    expect(result.code).toContain('createRoot');
    expect(result.code).toContain('function App(');
    expect(result.code).not.toContain('app.css');
  });

  it('reports a missing entry file', async () => {
    const result = await bundleApp({ files: [{ path: 'a.tsx', content: '' }], entry: 'b.tsx', exportName: 'default' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('"b.tsx"');
  });

  it('reports syntax errors with file and line', async () => {
    const result = await bundleApp({
      files: [{ path: 'Broken.tsx', content: `export default function Broken() {\n  return <div>;\n}` }],
      entry: 'Broken.tsx',
      exportName: 'default',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details[0]).toMatch(/^Broken\.tsx:\d+:\d+: /);
  });

  it('reports a missing named export', async () => {
    const result = await bundleApp({
      files: [{ path: 'A.tsx', content: `export function A() { return null; }` }],
      entry: 'A.tsx',
      exportName: 'B',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.details.join('\n')).toContain('"B"');
  });
});
