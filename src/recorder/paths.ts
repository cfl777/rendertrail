/**
 * Pure path helpers used by the bundler and the analyzer: match import specifiers to the files
 * Claude sent, the way a bundler would.
 */
import path from 'node:path';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'];

/** Paths as keys: forward slashes, no leading `./` or `/`. */
export function normalizePath(p: string): string {
  return path.posix
    .normalize(p.replace(/\\/g, '/'))
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

/**
 * Finds a file the way a bundler would: exact, with an extension, or as a folder index. A `.js`,
 * `.jsx` or `.mjs` import also matches the `.ts`/`.tsx` source (TypeScript's ESM convention).
 */
export function findFile(files: ReadonlyMap<string, string>, wanted: string): string | undefined {
  const base = normalizePath(wanted);
  const jsExt = /\.(js|jsx|mjs)$/.exec(base);
  const withoutJs = jsExt ? base.slice(0, -jsExt[0].length) : null;
  const candidates = [
    base,
    ...(withoutJs ? [`${withoutJs}.ts`, `${withoutJs}.tsx`] : []),
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

/** `@/x` and `~/x` path aliases, tried as `x`, `src/x`, and `x` without a leading `src/`. */
export function findAliased(files: ReadonlyMap<string, string>, spec: string): string | undefined {
  const alias = /^[@~]\/(.+)$/.exec(spec);
  if (!alias?.[1]) return undefined;
  const rest = normalizePath(alias[1]);
  const candidates = [rest, `src/${rest}`, rest.replace(/^src\//, '')];
  for (const candidate of candidates) {
    const found = findFile(files, candidate);
    if (found) return found;
  }
  return undefined;
}
