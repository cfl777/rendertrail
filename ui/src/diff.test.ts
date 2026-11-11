import { describe, expect, it } from 'vitest';
import { countChanges, hunks, lineDiff, startsLate, whitespaceOnly } from './diff';

describe('whitespaceOnly and startsLate', () => {
  it('sees CRLF, trailing spaces and trailing blank lines as whitespace only', () => {
    expect(whitespaceOnly('a\r\nb\r\n', 'a\nb')).toBe(true);
    expect(whitespaceOnly('a  \nb', 'a\nb\n\n')).toBe(true);
    expect(whitespaceOnly('a\nb', 'a\nc')).toBe(false);
  });

  it('knows when a hunk starts below line 1', () => {
    const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    expect(startsLate(hunks(lineDiff(before, before.replace('l8', 'L8')))[0]!)).toBe(true);
    expect(startsLate(hunks(lineDiff(before, before.replace('l0', 'L0')))[0]!)).toBe(false);
  });
});

const kinds = (before: string, after: string): string[] => lineDiff(before, after).map((l) => `${l.kind[0]} ${l.text}`);

describe('lineDiff', () => {
  it('marks unchanged, removed and added lines with their line numbers', () => {
    const lines = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(lines).toEqual([
      { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2 },
      { kind: 'add', text: 'B', newLine: 2 },
      { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
      { kind: 'add', text: 'd', newLine: 4 },
    ]);
    expect(countChanges(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('keeps the longest common run of lines (inserted line in the middle)', () => {
    expect(kinds('x\ny\nz', 'x\nnew\ny\nz')).toEqual(['s x', 'a new', 's y', 's z']);
  });

  it('treats CRLF and LF the same, and handles empty files', () => {
    expect(kinds('a\r\nb\r\n', 'a\nb\n')).toEqual(['s a', 's b']);
    expect(kinds('', 'a')).toEqual(['a a']);
    expect(kinds('a', '')).toEqual(['d a']);
    expect(kinds('', '')).toEqual([]);
  });

  it('shows removed lines before added ones within a change', () => {
    expect(kinds('1\nold1\nold2\n2', '1\nnew1\nnew2\n2')).toEqual(['s 1', 'd old1', 'd old2', 'a new1', 'a new2', 's 2']);
  });

  it('falls back to replace-all for very large middles', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join('\n');
    const lines = lineDiff(a, b);
    expect(countChanges(lines)).toEqual({ added: 1500, removed: 1500 });
  });
});

describe('hunks', () => {
  it('keeps 2 lines of context and splits far-apart changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2', 'L2').replace('l15', 'L15');
    const h = hunks(lineDiff(before, after));
    expect(h).toHaveLength(2);
    expect(h[0]!.lines.map((l) => l.text)).toEqual(['l0', 'l1', 'l2', 'L2', 'l3', 'l4']);
    expect(h[1]!.lines.map((l) => l.text)).toEqual(['l13', 'l14', 'l15', 'L15', 'l16', 'l17']);
  });

  it('is empty when nothing changed', () => {
    expect(hunks(lineDiff('a\nb', 'a\nb'))).toEqual([]);
  });
});
