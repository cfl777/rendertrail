/**
 * examples/laggy-search/src is a copy of the golden fixture fixtures/laggy-search, so the example
 * gives strangers the finding the golden tests check. The only difference allowed is the note at
 * the end of each file's first line (kept there so line numbers match, e.g. SearchPage.tsx:19).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'laggy-search');
const EXAMPLE = path.join(ROOT, 'examples', 'laggy-search', 'src');
const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('examples/laggy-search', () => {
  const copies = readdirSync(EXAMPLE).filter((name) => name !== 'main.tsx');

  it('has every fixture component except the fixed version', () => {
    const fixture = readdirSync(FIXTURE).filter((name) => /\.tsx?$/.test(name) && !name.includes('.fixed'));
    expect(copies.sort()).toEqual(fixture.sort());
  });

  it.each(copies)('%s is the same as the fixture', (name) => {
    const note = ` // Same as fixtures/laggy-search/${name} in the ${BRAND.displayName} repo (a test there keeps the two the same).`;
    const lines = read(path.join(EXAMPLE, name)).split('\n');
    expect(lines[0]?.endsWith(note), `${name}: first line should end with the copy note`).toBe(true);
    lines[0] = lines[0]?.slice(0, -note.length) ?? '';
    expect(lines.join('\n')).toBe(read(path.join(FIXTURE, name)));
  });
});
