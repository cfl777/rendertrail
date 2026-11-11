/**
 * A small line diff for "What changed in my code?": longest common subsequence on the lines
 * between the common head and tail, grouped into hunks with a little context.
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 1-based line in the old file (same, del). */
  oldLine?: number;
  /** 1-based line in the new file (same, add). */
  newLine?: number;
}

export interface Hunk {
  lines: DiffLine[];
}

/** Above this many cells the LCS table is skipped and the middle shows as replaced. */
const MAX_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i += 1) out.push({ kind: 'same', text: a[i]!, oldLine: i + 1, newLine: i + 1 });

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ kind: 'del', text, oldLine: head + i + 1 }));
    midB.forEach((text, j) => out.push({ kind: 'add', text, newLine: head + j + 1 }));
  } else {
    // lcs[i][j]: length of the LCS of midA[i..] and midB[j..], in one flat array.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i]!, oldLine: head + i + 1, newLine: head + j + 1 });
        i += 1;
        j += 1;
      } else if (j < m && (i === n || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
        out.push({ kind: 'add', text: midB[j]!, newLine: head + j + 1 });
        j += 1;
      } else {
        out.push({ kind: 'del', text: midA[i]!, oldLine: head + i + 1 });
        i += 1;
      }
    }
  }

  for (let k = 0; k < tail; k += 1) {
    out.push({ kind: 'same', text: a[a.length - tail + k]!, oldLine: a.length - tail + k + 1, newLine: b.length - tail + k + 1 });
  }
  // Within a run of changes, show the removed lines before the added ones.
  return reorderRuns(out);
}

function reorderRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (): void => {
    out.push(...run.filter((l) => l.kind === 'del'), ...run.filter((l) => l.kind === 'add'));
    run = [];
  };
  for (const line of lines) {
    if (line.kind === 'same') {
      flush();
      out.push(line);
    } else run.push(line);
  }
  flush();
  return out;
}

/** Changed lines with `context` unchanged lines around them; far-apart changes become separate hunks. */
export function hunks(lines: readonly DiffLine[], context = 2): Hunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) keep[k] = true;
  });
  const result: Hunk[] = [];
  let current: DiffLine[] | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!keep[i]) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      result.push({ lines: current });
    }
    current.push(lines[i]!);
  }
  return result;
}

export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  };
}

/** True when the two texts differ only in whitespace: line endings, trailing spaces, blank lines at the end. */
export function whitespaceOnly(before: string, after: string): boolean {
  const norm = (text: string): string =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/\n+$/, '');
  return norm(before) === norm(after);
}

/** True when the hunk starts after line 1 of both files, so lines above it are hidden. */
export function startsLate(h: Hunk): boolean {
  const first = h.lines[0];
  return first !== undefined && (first.oldLine ?? first.newLine ?? 1) > 1;
}
