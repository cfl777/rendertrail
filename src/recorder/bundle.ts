/**
 * Bundles the files Claude passed in (held in memory) into one browser script that mounts the
 * entry component with production React and `react-dom/profiling`, plus the page instrumentation.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAliased, findFile, normalizePath } from './paths.js';
import { build, type BuildFailure, type BuildOptions, type Loader, type Message, type Plugin } from 'esbuild';

export { findAliased, findFile, normalizePath };

const require = createRequire(import.meta.url);

const FILE_NS = 'rt-file';
const STUB_NS = 'rt-stub';
const EMPTY_NS = 'rt-empty';
const ENTRY_ID = 'virtual:entry';
const ENTRY_FILE = '__entry__.tsx';

const REACT_IMPORT = /^(react|react-dom)(\/.*)?$/;
const STYLE_IMPORT = /\.(css|scss|sass|less|styl)(\?.*)?$/;

/** Shared by the app bundle and the instrumentation (HANDOFF.md §6). */
const COMMON: BuildOptions = {
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minifySyntax: true, // drops React's dev-only branches (otherwise React logs a dead-code warning)
  keepNames: true, // keep component names exactly as written (no ResultsList2)
  logLevel: 'silent',
  // Production React with the profiling build: real-world speed, and React still measures render times.
  define: { 'process.env.NODE_ENV': '"production"' },
};

export interface SourceFile {
  path: string;
  content: string;
}

export interface BundleRequest {
  files: SourceFile[];
  entry: string;
  exportName: string;
  props?: Record<string, unknown>;
}

export type BundleResult =
  | { ok: true; code: string; stubs: string[] }
  | { ok: false; message: string; details: string[]; stubs: string[] };

function loaderFor(file: string): Loader {
  const ext = path.posix.extname(file);
  if (ext === '.tsx' || ext === '.ts' || ext === '.jsx' || ext === '.json') return ext.slice(1) as Loader;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'jsx';
  return 'text';
}

/** Named imports of `spec` across the given sources, so the stub module can export them. */
export function namedImportsOf(spec: string, sources: Iterable<string>): string[] {
  const names = new Set<string>();
  const statement = /\b(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const source of sources) {
    for (const match of source.matchAll(statement)) {
      if (match[2] !== spec) continue;
      const braces = /\{([\s\S]*?)\}/.exec(match[1] ?? '');
      if (!braces?.[1]) continue;
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

// A harmless stand-in. As a component it renders its children (so stubbed providers and wrappers
// don't hide the app) or nothing; as a hook (useX) it returns another stand-in, so destructuring
// works. Any property is another stand-in. React sees a plain function component (no prototype,
// no $$typeof).
const STUB_RUNTIME = `
const UNDEFINED_KEYS = new Set(['prototype', '$$typeof', 'then', 'toJSON', '__esModule', 'defaultProps',
  'propTypes', 'contextTypes', 'childContextTypes', 'contextType', 'getDerivedStateFromProps', 'compare',
  'render', 'type', '_context', '_payload', '_init']);
const HOOK_NAME = /^use[A-Z]/;
function makeStub(label, isHook) {
  const cache = new Map();
  return new Proxy(() => null, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) {
        // Array destructuring of a hook result: a few stand-ins, finite so spreading can't hang.
        return function* () {
          for (let i = 0; i < 8; i += 1) yield makeStub(label + '[' + i + ']', false);
        };
      }
      if (typeof key === 'symbol') return undefined;
      if (key === 'displayName' || key === 'name') return label;
      if (key === 'toString' || key === 'valueOf') return () => '';
      if (UNDEFINED_KEYS.has(key)) return undefined;
      if (!cache.has(key)) cache.set(key, makeStub(label + '.' + key, HOOK_NAME.test(key)));
      return cache.get(key);
    },
    apply(target, thisArg, args) {
      if (isHook) return makeStub(label + '()', false);
      const props = args[0];
      const children = props !== null && typeof props === 'object' ? props.children : undefined;
      return children === undefined || typeof children === 'function' ? null : children;
    },
  });
}
`;

function stubModule(spec: string, names: string[]): string {
  const label = `Stub(${spec})`;
  return [
    STUB_RUNTIME,
    `const stub = makeStub(${JSON.stringify(label)}, ${/^use[A-Z]/.test(path.posix.basename(spec))});`,
    'export default stub;',
    ...names.map((name) => `export const ${name} = stub[${JSON.stringify(name)}];`),
  ].join('\n');
}

/** Resolve react and react-dom from our own node_modules (works from src/ and from dist/). */
function reactResolveDir(spec: string): string {
  const pkg = spec.startsWith('react-dom') ? 'react-dom' : 'react';
  const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
  return path.dirname(path.dirname(pkgDir)); // the folder that holds node_modules/<pkg>
}

function entrySource(req: BundleRequest, entryPath: string): string {
  const importRoot = req.exportName === 'default' ? 'Root' : `{ ${req.exportName} as Root }`;
  return [
    `import { createRoot } from 'react-dom/profiling';`,
    `import ${importRoot} from ${JSON.stringify(`./${entryPath}`)};`,
    `const props = ${JSON.stringify(req.props ?? {})};`,
    // No StrictMode: its double renders would distort the counts.
    `createRoot(document.getElementById('root')).render(<Root {...props} />);`,
  ].join('\n');
}

function virtualFiles(req: BundleRequest, entryPath: string, stubs: Set<string>): Plugin {
  const files = new Map(req.files.map((file) => [normalizePath(file.path), file.content]));
  return {
    name: 'virtual-files',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: new RegExp(`^${ENTRY_ID}$`) }, () => ({ path: ENTRY_FILE, namespace: FILE_NS }));

      pluginBuild.onResolve({ filter: /.*/, namespace: FILE_NS }, async (args) => {
        if (STYLE_IMPORT.test(args.path)) return { path: args.path, namespace: EMPTY_NS };
        if (REACT_IMPORT.test(args.path)) {
          return pluginBuild.resolve(args.path, { kind: args.kind, resolveDir: reactResolveDir(args.path) });
        }
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const wanted = args.path.startsWith('/')
            ? args.path
            : path.posix.join(path.posix.dirname(args.importer), args.path);
          const found = findFile(files, wanted);
          if (found) return { path: found, namespace: FILE_NS };
        }
        const aliased = findAliased(files, args.path);
        if (aliased) return { path: aliased, namespace: FILE_NS };
        stubs.add(`${args.path} (imported by ${args.importer})`);
        return { path: args.path, namespace: STUB_NS };
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: FILE_NS }, (args) => {
        if (args.path === ENTRY_FILE) return { contents: entrySource(req, entryPath), loader: 'tsx', resolveDir: '/' };
        return { contents: files.get(args.path) ?? '', loader: loaderFor(args.path) };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: STUB_NS }, (args) => ({
        contents: stubModule(args.path, namedImportsOf(args.path, files.values())),
        loader: 'js',
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({ contents: '', loader: 'js' }));
    },
  };
}

function formatMessage(message: Message): string {
  const loc = message.location;
  if (!loc) return message.text;
  const file = loc.file.replace(new RegExp(`^(${FILE_NS}|${STUB_NS}):`), '');
  return `${file}:${loc.line}:${loc.column + 1}: ${message.text}${loc.lineText ? `\n    ${loc.lineText.trim()}` : ''}`;
}

function isBuildFailure(err: unknown): err is BuildFailure {
  return err instanceof Error && Array.isArray((err as Partial<BuildFailure>).errors);
}

export async function bundleApp(req: BundleRequest): Promise<BundleResult> {
  const files = new Map(req.files.map((file) => [normalizePath(file.path), file.content]));
  const stubs = new Set<string>();
  const entryPath = findFile(files, req.entry);
  if (!entryPath) {
    return {
      ok: false,
      message: `The entry file "${req.entry}" isn't among the files.`,
      details: [`Files: ${[...files.keys()].join(', ')}`],
      stubs: [],
    };
  }
  try {
    const result = await build({
      ...COMMON,
      entryPoints: [ENTRY_ID],
      jsx: 'automatic',
      plugins: [virtualFiles(req, entryPath, stubs)],
    });
    const code = result.outputFiles?.[0]?.text;
    if (code === undefined) throw new Error('esbuild produced no output');
    return { ok: true, code, stubs: [...stubs].sort() };
  } catch (err) {
    const details = isBuildFailure(err)
      ? err.errors.map(formatMessage)
      : [err instanceof Error ? err.message : 'Unknown bundling error'];
    return { ok: false, message: "The files couldn't be bundled.", details, stubs: [...stubs].sort() };
  }
}

const instrumentation = new Map<string, Promise<string>>();

/**
 * The page instrumentation (bippy inlined). The build puts it at dist/instrument.js next to
 * dist/server.js; when running from source (tests) it's bundled from page/instrument.ts. A failure
 * isn't cached, so the next call tries again.
 */
export function loadInstrumentation(dir = path.dirname(fileURLToPath(import.meta.url))): Promise<string> {
  let loading = instrumentation.get(dir);
  if (!loading) {
    loading = readInstrumentation(dir).catch((err: unknown) => {
      instrumentation.delete(dir);
      throw err;
    });
    instrumentation.set(dir, loading);
  }
  return loading;
}

async function readInstrumentation(dir: string): Promise<string> {
  const built = path.join(dir, 'instrument.js');
  try {
    return await readFile(built, 'utf8');
  } catch {
    // not built: fall back to the source (running from src/)
  }
  const source = path.join(dir, 'page', 'instrument.ts');
  if (!existsSync(source)) {
    throw new Error(`the page instrumentation is missing (no ${built}). Reinstall the package, or run npm run build in a checkout.`);
  }
  const result = await build({ ...COMMON, entryPoints: [source] });
  const code = result.outputFiles?.[0]?.text;
  if (code === undefined) throw new Error('esbuild produced no instrumentation output');
  return code;
}

/** Version of the React we record with (from our own node_modules). */
export function reactVersion(): string {
  const pkg: unknown = require('react/package.json');
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
    ? pkg.version
    : 'unknown';
}
