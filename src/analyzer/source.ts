/**
 * Pure: read the files Claude sent with the TypeScript compiler API (`ts.createSourceFile`, syntax
 * only, no type checking) to confirm findings and find the line to change (HANDOFF.md §7).
 * Components and custom hooks are matched by function name across the files; component names are
 * widened with their aliases (the variable a memo/forwardRef result is assigned to, and the names
 * it is imported under).
 *
 * The compiler is large (about 9 MB of JavaScript), so it is loaded lazily: call loadTypeScript()
 * once before anything else here. The type-only import below costs nothing at runtime.
 */
import path from 'node:path';
import type ts from 'typescript';
import { findAliased, findFile, normalizePath } from '../recorder/paths.js';

let T = undefined as unknown as typeof ts;
let loaded = false;

/** Loads the TypeScript compiler once. */
export async function loadTypeScript(): Promise<void> {
  if (loaded) return;
  const mod = (await import('typescript')) as unknown as typeof ts & { default?: typeof ts };
  T = mod.default ?? mod;
  loaded = true;
}

export interface ParsedFile {
  path: string;
  source: ts.SourceFile;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

export function parseFiles(files: readonly { path: string; content: string }[]): ParsedFile[] {
  if (!loaded) throw new Error('loadTypeScript() must run before parseFiles()');
  return files
    .filter((file) => SCRIPT.test(file.path))
    .map((file) => ({
      path: file.path,
      source: T.createSourceFile(file.path, file.content, T.ScriptTarget.Latest, true, kindOf(file.path)),
    }));
}

function kindOf(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return T.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return T.ScriptKind.JSX;
  if (/\.[cm]?ts$/.test(lower)) return T.ScriptKind.TS;
  return T.ScriptKind.JSX; // .js files often hold JSX too
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** Import specifiers in a file: import/export … from, import(), require(). */
function importSpecifiers(file: ParsedFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((T.isImportDeclaration(node) || T.isExportDeclaration(node)) && node.moduleSpecifier && T.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (T.isCallExpression(node) && node.arguments.length === 1 && T.isStringLiteral(node.arguments[0]!)) {
      const isImport = node.expression.kind === T.SyntaxKind.ImportKeyword;
      const isRequire = T.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) specs.push((node.arguments[0] as ts.StringLiteral).text);
    }
    T.forEachChild(node, visit);
  };
  visit(file.source);
  return specs;
}

/** The sent file an import specifier points at (normalized path), the way the bundler resolves it. */
function resolveImport(keys: ReadonlyMap<string, string>, importer: string, spec: string): string | undefined {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return findFile(keys, spec.startsWith('/') ? spec : path.posix.join(path.posix.dirname(normalizePath(importer)), spec));
  }
  return findAliased(keys, spec);
}

function keysOf(files: readonly ParsedFile[]): Map<string, string> {
  return new Map(files.map((f) => [normalizePath(f.path), '']));
}

/**
 * The files the entry pulls in, directly or through other files (what the bundle contains). Files
 * that aren't imported can't have rendered, so the analyzer ignores them. All files when the entry
 * isn't among them.
 */
export function reachableFrom(files: readonly ParsedFile[], entry: string): ParsedFile[] {
  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]));
  const keys = keysOf(files);
  const start = findFile(keys, entry);
  if (!start) return [...files];
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    const file = byPath.get(current);
    if (!file) continue;
    for (const spec of importSpecifiers(file)) {
      const found = resolveImport(keys, current, spec);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return files.filter((f) => seen.has(normalizePath(f.path)));
}

// ---------------------------------------------------------------------------
// Functions and names
// ---------------------------------------------------------------------------

export type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return T.isFunctionDeclaration(node) || T.isFunctionExpression(node) || T.isArrowFunction(node) || T.isMethodDeclaration(node);
}

export function lineOf(file: ParsedFile, node: ts.Node): number {
  return file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1;
}

export function snippetOf(file: ParsedFile, node: ts.Node, max = 90): string {
  const text = node.getText(file.source).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function textOf(file: ParsedFile, node: ts.Node): string {
  return node.getText(file.source).replace(/\s+/g, ' ').trim();
}

/** The variable a function is assigned to, directly or through calls such as memo/forwardRef. */
function assignedVariable(node: ts.Node): ts.VariableDeclaration | null {
  let parent: ts.Node = node.parent;
  while (T.isCallExpression(parent) || T.isParenthesizedExpression(parent) || T.isAsExpression(parent)) parent = parent.parent;
  return T.isVariableDeclaration(parent) && T.isIdentifier(parent.name) ? parent : null;
}

/** Name of a function as React would show it: its own name, or the variable it's assigned to (through memo/forwardRef). */
export function functionName(node: FunctionLike): string | null {
  if ((T.isFunctionDeclaration(node) || T.isFunctionExpression(node)) && node.name) return node.name.text;
  if (T.isMethodDeclaration(node)) return T.isIdentifier(node.name) ? node.name.text : null;
  const variable = assignedVariable(node);
  return variable && T.isIdentifier(variable.name) ? variable.name.text : null;
}

/** Every function in the files whose name (see functionName) is `name`. */
export function findFunctions(files: readonly ParsedFile[], name: string): { file: ParsedFile; fn: FunctionLike }[] {
  const found: { file: ParsedFile; fn: FunctionLike }[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && functionName(node) === name) found.push({ file, fn: node });
      T.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return T.canHaveModifiers(node) && (T.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** True when `fn` (bound as `binding` in its file) is the file's default export. */
function isDefaultExport(file: ParsedFile, fn: FunctionLike, binding: string): boolean {
  if (T.isFunctionDeclaration(fn) && hasModifier(fn, T.SyntaxKind.DefaultKeyword)) return true;
  return file.source.statements.some((s) => {
    if (!T.isExportAssignment(s) || s.isExportEquals) return false;
    let expr: ts.Node | undefined = s.expression;
    while (expr) {
      if (expr === fn) return true;
      if (T.isIdentifier(expr)) return expr.text === binding;
      if (T.isCallExpression(expr)) expr = expr.arguments[0];
      else if (T.isParenthesizedExpression(expr) || T.isAsExpression(expr)) expr = expr.expression;
      else return false;
    }
    return false;
  });
}

/**
 * Names the component React calls `name` can have in JSX: the name itself, the variable a
 * memo/forwardRef result is assigned to (`const ResultsList = memo(function List…)`), and the
 * names it is imported under (default imports, `{ X as Y }`).
 */
export function componentAliases(files: readonly ParsedFile[], name: string): Set<string> {
  const aliases = new Set([name]);
  const keys = keysOf(files);
  for (const { file, fn } of findFunctions(files, name)) {
    const variable = assignedVariable(fn);
    const binding = variable && T.isIdentifier(variable.name) ? variable.name.text : name;
    aliases.add(binding);
    const isDefault = isDefaultExport(file, fn, binding);
    const target = normalizePath(file.path);
    for (const other of files) {
      for (const s of other.source.statements) {
        if (!T.isImportDeclaration(s) || !T.isStringLiteral(s.moduleSpecifier) || !s.importClause) continue;
        if (resolveImport(keys, other.path, s.moduleSpecifier.text) !== target) continue;
        if (isDefault && s.importClause.name) aliases.add(s.importClause.name.text);
        const named = s.importClause.namedBindings;
        if (named && T.isNamedImports(named)) {
          for (const el of named.elements) if ((el.propertyName ?? el.name).text === binding) aliases.add(el.name.text);
        }
      }
    }
  }
  return aliases;
}

/** Names of the named functions around a node, innermost first. */
export function enclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) {
      const name = functionName(current);
      if (name) names.push(name);
    }
  }
  return names;
}

function innermostNamedFunction(node: ts.Node): FunctionLike | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionLike(current) && functionName(current)) return current;
  }
  return null;
}

/** Visit a function's body without entering nested functions (callbacks, handlers, timers). */
function walkBody(fn: FunctionLike, visit: (node: ts.Node) => void, order: 'pre' | 'post' = 'pre'): void {
  const walk = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (order === 'pre') visit(node);
    T.forEachChild(node, walk);
    if (order === 'post') visit(node);
  };
  if (fn.body) walk(fn.body);
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (T.isIdentifier(callee)) return callee.text;
  if (T.isPropertyAccessExpression(callee)) return callee.name.text; // React.useState
  return null;
}

/** Names bound by a binding pattern or identifier. */
function bindingNames(name: ts.BindingName): string[] {
  if (T.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (T.isBindingElement(el) ? bindingNames(el.name) : []));
}

// ---------------------------------------------------------------------------
// Hooks in order (rule 2: map the recorded hook index to its useState)
// ---------------------------------------------------------------------------

/** Entries each built-in hook adds to the component's hook list. useContext and use add none. */
const BUILTIN_HOOK_SLOTS: Record<string, number | null> = {
  useState: 1,
  useReducer: 1,
  useEffect: 1,
  useLayoutEffect: 1,
  useInsertionEffect: 1,
  useMemo: 1,
  useCallback: 1,
  useRef: 1,
  useImperativeHandle: 1,
  useId: 1,
  useDeferredValue: 1,
  useEffectEvent: 1,
  useOptimistic: 1,
  useTransition: 2,
  useSyncExternalStore: 2,
  useActionState: null,
  useFormState: null,
  useContext: 0,
  use: 0,
  useDebugValue: 0,
  useFormStatus: 0,
};

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
const MAX_HOOK_DEPTH = 8;

/** A name the setter is known by in some function (its own hook, or a caller that destructured it). */
export interface SetterSite {
  name: string;
  fn: FunctionLike;
  file: ParsedFile;
}

export interface HookEntry {
  name: string;
  /** Index in the component's hook list; null when an earlier hook's size is unknown. */
  index: number | null;
  call: ts.CallExpression;
  file: ParsedFile;
  /** Component or custom hook that calls it. */
  owner: { name: string; fn: FunctionLike; file: ParsedFile };
  /** useState / useReducer: `const [state, setter] = …`. */
  state: string | null;
  setter: string | null;
  /** The setter under other names in callers: `const [on, setOn] = useToggle()` when useToggle returns it. */
  aliases: SetterSite[];
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name) || name === 'use';
}

function findHookDefinition(files: readonly ParsedFile[], name: string): { file: ParsedFile; fn: FunctionLike } | null {
  const found = findFunctions(files, name);
  return found.length === 1 ? found[0]! : null;
}

/** What a custom hook returns, by position (`return [a, b]`) or key (`return { a, b: c }`): the hook-local names. */
function returnedNames(fn: FunctionLike): { byIndex: (string | null)[]; byKey: Map<string, string> } | null {
  const ret = { value: null as ts.Expression | null };
  walkBody(fn, (node) => {
    if (!ret.value && T.isReturnStatement(node) && node.expression) {
      const e = node.expression;
      if (T.isArrayLiteralExpression(e) || T.isObjectLiteralExpression(e) || T.isAsExpression(e)) ret.value = e;
    }
  });
  if (!ret.value && fn.body && !T.isBlock(fn.body)) ret.value = fn.body;
  let e = ret.value;
  while (e && (T.isAsExpression(e) || T.isParenthesizedExpression(e))) e = e.expression;
  if (!e) return null;
  if (T.isArrayLiteralExpression(e)) return { byIndex: e.elements.map((el) => (T.isIdentifier(el) ? el.text : null)), byKey: new Map() };
  if (T.isObjectLiteralExpression(e)) {
    const byKey = new Map<string, string>();
    for (const p of e.properties) {
      if (T.isShorthandPropertyAssignment(p)) byKey.set(p.name.text, p.name.text);
      else if (T.isPropertyAssignment(p) && T.isIdentifier(p.name) && T.isIdentifier(p.initializer)) byKey.set(p.name.text, p.initializer.text);
    }
    return { byIndex: [], byKey };
  }
  return null;
}

/** For `const [x, y] = useHook()` / `const { a: b } = useHook()`: hook-local returned name → caller's local name. */
function destructuredReturn(call: ts.CallExpression, definition: FunctionLike): Map<string, string> {
  const map = new Map<string, string>();
  const decl = call.parent;
  if (!T.isVariableDeclaration(decl)) return map;
  const returned = returnedNames(definition);
  if (!returned) return map;
  if (T.isArrayBindingPattern(decl.name)) {
    decl.name.elements.forEach((el, i) => {
      const inner = returned.byIndex[i];
      if (inner && T.isBindingElement(el) && T.isIdentifier(el.name)) map.set(inner, el.name.text);
    });
  } else if (T.isObjectBindingPattern(decl.name)) {
    for (const el of decl.name.elements) {
      const key = el.propertyName && T.isIdentifier(el.propertyName) ? el.propertyName.text : T.isIdentifier(el.name) ? el.name.text : null;
      const inner = key ? returned.byKey.get(key) : undefined;
      if (inner && T.isIdentifier(el.name)) map.set(inner, el.name.text);
    }
  }
  return map;
}

/**
 * The hook list of a component in call order, custom hooks from the given files expanded in place.
 * After a hook whose size is unknown (a custom hook that wasn't sent, useActionState), indexes are null.
 */
export function listHooks(files: readonly ParsedFile[], file: ParsedFile, fn: FunctionLike): HookEntry[] {
  const entries: HookEntry[] = [];
  let next: number | null = 0;
  const expand = (ownerFile: ParsedFile, owner: FunctionLike, depth: number, stack: Set<FunctionLike>): void => {
    const ownerName = functionName(owner) ?? 'anonymous';
    walkBody(
      owner,
      (node) => {
        if (!T.isCallExpression(node)) return;
        const name = calleeName(node);
        if (!name || !isHookName(name)) return;
        if (name in BUILTIN_HOOK_SLOTS) {
          const slots: number | null = BUILTIN_HOOK_SLOTS[name] ?? null;
          if (slots === 0) return;
          const binding = T.isVariableDeclaration(node.parent) && T.isArrayBindingPattern(node.parent.name) ? node.parent.name : null;
          const element = (i: number): string | null => {
            const el = binding?.elements[i];
            return el && T.isBindingElement(el) && T.isIdentifier(el.name) ? el.name.text : null;
          };
          const stateful = name === 'useState' || name === 'useReducer';
          entries.push({
            name,
            index: next,
            call: node,
            file: ownerFile,
            owner: { name: ownerName, fn: owner, file: ownerFile },
            state: stateful ? element(0) : null,
            setter: stateful ? element(1) : null,
            aliases: [],
          });
          next = slots === null || next === null ? null : next + slots;
          return;
        }
        const definition = depth < MAX_HOOK_DEPTH ? findHookDefinition(files, name) : null;
        if (!definition || stack.has(definition.fn)) {
          next = null; // a hook we can't see: its size is unknown
          return;
        }
        const start = entries.length;
        stack.add(definition.fn);
        expand(definition.file, definition.fn, depth + 1, stack);
        stack.delete(definition.fn);
        // A setter the custom hook returns, destructured here under a local name.
        const renamed = destructuredReturn(node, definition.fn);
        for (const entry of entries.slice(start)) {
          const sites: SetterSite[] = [
            ...(entry.setter ? [{ name: entry.setter, fn: entry.owner.fn, file: entry.owner.file }] : []),
            ...entry.aliases,
          ];
          for (const site of sites) {
            const local = site.fn === definition.fn ? renamed.get(site.name) : undefined;
            if (local) entry.aliases.push({ name: local, fn: owner, file: ownerFile });
          }
        }
      },
      'post', // arguments run before the call itself
    );
  };
  expand(file, fn, 0, new Set([fn]));
  return entries;
}

export interface SyncSetterCall {
  setter: string;
  /** The setter call inside the effect body. */
  call: ts.CallExpression;
  effect: string;
  file: ParsedFile;
  owner: string;
}

/** Setter calls made synchronously in the body of an effect in `owner` (not in timers, promises or handlers). */
export function syncSetterCallsInEffects(file: ParsedFile, owner: FunctionLike, setters: ReadonlySet<string>): SyncSetterCall[] {
  const calls: SyncSetterCall[] = [];
  walkBody(owner, (node) => {
    if (!T.isCallExpression(node)) return;
    const effect = calleeName(node);
    if (!effect || !EFFECT_HOOKS.has(effect)) return;
    const callback = node.arguments[0];
    if (!callback || !(T.isArrowFunction(callback) || T.isFunctionExpression(callback))) return;
    const check = (inner: ts.Node): void => {
      if (T.isCallExpression(inner) && T.isIdentifier(inner.expression) && setters.has(inner.expression.text)) {
        calls.push({ setter: inner.expression.text, call: inner, effect, file, owner: functionName(owner) ?? 'anonymous' });
      }
    };
    walkBody(callback, check);
  });
  return calls;
}

/** Synchronous effect calls to a hook's setter, under any of its names. */
function setterCalls(entry: HookEntry): SyncSetterCall[] {
  const sites: SetterSite[] = [...(entry.setter ? [{ name: entry.setter, fn: entry.owner.fn, file: entry.owner.file }] : []), ...entry.aliases];
  return sites.flatMap((site) => syncSetterCallsInEffects(site.file, site.fn, new Set([site.name])));
}

export interface StateInEffectSource {
  /** useState or useReducer. */
  hook: string;
  state: string | null;
  /** The setter's name where the hook declares it. */
  setter: string;
  /** The function that declares the state (component or custom hook). */
  owner: string;
  /** The setter call in the effect (possibly under another name, in a caller). */
  file: ParsedFile;
  call: ts.CallExpression;
  effect: string;
  /** True when the hook index was matched to its useState; false when the only candidate was used. */
  matchedByIndex: boolean;
}

/**
 * Rule 2, source side: the component's state hook number `hookIndex` is set synchronously inside
 * an effect. Null when the source doesn't confirm it.
 */
export function confirmStateInEffect(files: readonly ParsedFile[], component: string, hookIndex: number): StateInEffectSource | null {
  for (const { file, fn } of findFunctions(files, component)) {
    const hooks = listHooks(files, file, fn);
    const stateHooks = hooks.filter((h) => h.setter !== null);
    const result = (h: HookEntry, call: SyncSetterCall, matchedByIndex: boolean): StateInEffectSource => ({
      hook: h.name,
      state: h.state,
      setter: h.setter!,
      owner: h.owner.name,
      file: call.file,
      call: call.call,
      effect: call.effect,
      matchedByIndex,
    });
    const byIndex = hooks.find((h) => h.index === hookIndex);
    if (byIndex) {
      if (!byIndex.setter) continue; // the index points at a hook that isn't useState/useReducer
      const first = setterCalls(byIndex)[0];
      return first ? result(byIndex, first, true) : null; // set elsewhere (a timer, a handler): not this rule
    }
    // Ambiguous: fall back to the only state hook whose setter is called synchronously in an effect.
    const withCalls = stateHooks.map((h) => ({ h, calls: setterCalls(h) })).filter((x) => x.calls.length > 0);
    const only = withCalls[0];
    if (withCalls.length === 1 && only) return result(only.h, only.calls[0]!, false);
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX lookup (rule 1: the element that passes the unstable prop)
// ---------------------------------------------------------------------------

export type PropValueKind =
  | 'inline-object'
  | 'inline-array'
  | 'inline-function'
  | 'local-object'
  | 'local-array'
  | 'local-function'
  | 'memoized'
  | 'prop'
  | 'other';

export interface JsxPropMatch {
  file: ParsedFile;
  attribute: ts.JsxAttribute;
  line: number;
  snippet: string;
  /** Named functions around the element, innermost first (the component that creates it is among them). */
  enclosing: string[];
  valueKind: PropValueKind;
  /** The expression that creates the value (inline, or the local variable's initializer). */
  valueExpression: ts.Expression | null;
  /** The local variable passed, if any: `filters={filters}` → "filters". */
  variable: string | null;
  /** valueKind 'prop': the component whose props it comes from, and the prop's name there. */
  fromProp: { component: string; prop: string } | null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (T.isParenthesizedExpression(current) || T.isAsExpression(current) || T.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function literalKind(expr: ts.Expression, scope: 'inline' | 'local'): PropValueKind | null {
  const e = unwrap(expr);
  if (T.isObjectLiteralExpression(e)) return `${scope}-object`;
  if (T.isArrayLiteralExpression(e)) return `${scope}-array`;
  if (T.isArrowFunction(e) || T.isFunctionExpression(e)) return `${scope}-function`;
  if (T.isCallExpression(e)) {
    const name = calleeName(e);
    if (name === 'useMemo' || name === 'useCallback') return 'memoized';
  }
  return null;
}

/** The prop name a parameter binding reads: `{ filters }` → filters, `{ filters: f }` (asked for f) → filters. */
function propNameOf(param: ts.ParameterDeclaration, local: string): string | null {
  if (!T.isObjectBindingPattern(param.name)) return null;
  for (const el of param.name.elements) {
    if (T.isIdentifier(el.name) && el.name.text === local) {
      if (el.propertyName && T.isIdentifier(el.propertyName)) return el.propertyName.text;
      return local;
    }
  }
  return null;
}

type Classified = Pick<JsxPropMatch, 'valueKind' | 'valueExpression' | 'variable' | 'fromProp'>;

function classify(attribute: ts.JsxAttribute): Classified {
  const none = { valueExpression: null, variable: null, fromProp: null };
  const init = attribute.initializer;
  const expr = init && T.isJsxExpression(init) ? init.expression : undefined;
  if (!expr) return { valueKind: 'other', ...none };
  const inline = literalKind(expr, 'inline');
  if (inline) return { ...none, valueKind: inline, valueExpression: unwrap(expr) };
  const target = unwrap(expr);
  // props.filters, where props is the component's parameter
  if (T.isPropertyAccessExpression(target) && T.isIdentifier(target.expression)) {
    const objectName = target.expression.text;
    for (let scope: ts.Node | undefined = attribute.parent; scope; scope = scope.parent) {
      if (!isFunctionLike(scope)) continue;
      if (scope.parameters.some((p) => T.isIdentifier(p.name) && p.name.text === objectName)) {
        const component = functionName(scope);
        return { ...none, valueKind: 'prop', variable: target.name.text, fromProp: component ? { component, prop: target.name.text } : null };
      }
    }
    return { ...none, valueKind: 'other', valueExpression: target };
  }
  if (!T.isIdentifier(target)) return { ...none, valueKind: 'other', valueExpression: target };
  const name = target.text;
  // Look the name up in the functions around the element, innermost first.
  for (let scope: ts.Node | undefined = attribute.parent; scope; scope = scope.parent) {
    if (!isFunctionLike(scope)) continue;
    const param = scope.parameters.find((p) => bindingNames(p.name).includes(name));
    if (param) {
      const component = functionName(scope);
      const prop = propNameOf(param, name);
      return { ...none, valueKind: 'prop', variable: name, fromProp: component && prop ? { component, prop } : null };
    }
    const found: { value: { kind: PropValueKind; expression: ts.Expression | null } | null } = { value: null };
    walkBody(scope, (node) => {
      if (found.value) return;
      if (T.isVariableDeclaration(node) && T.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        found.value = { kind: literalKind(node.initializer, 'local') ?? 'other', expression: unwrap(node.initializer) };
      }
    });
    // Function declarations inside the component are recreated on every render too.
    const body = scope.body;
    if (!found.value && body && T.isBlock(body)) {
      const decl = body.statements.find((s): s is ts.FunctionDeclaration => T.isFunctionDeclaration(s) && s.name?.text === name);
      if (decl) found.value = { kind: 'local-function', expression: null };
    }
    if (found.value) return { valueKind: found.value.kind, valueExpression: found.value.expression, variable: name, fromProp: null };
  }
  return { ...none, valueKind: 'other', variable: name }; // module level, or not found
}

function tagName(tag: ts.JsxTagNameExpression): string | null {
  if (T.isIdentifier(tag)) return tag.text;
  if (T.isPropertyAccessExpression(tag)) return tag.name.text;
  return null;
}

/** JSX elements `<Component prop=…>` in the files (under any of the component's aliases), with where their value comes from. */
export function findJsxProp(files: readonly ParsedFile[], component: string, prop: string): JsxPropMatch[] {
  const aliases = componentAliases(files, component);
  const matches: JsxPropMatch[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (T.isJsxSelfClosingElement(node) || T.isJsxOpeningElement(node)) {
        const tag = tagName(node.tagName);
        if (tag && aliases.has(tag)) {
          for (const attr of node.attributes.properties) {
            if (T.isJsxAttribute(attr) && T.isIdentifier(attr.name) && attr.name.text === prop) {
              matches.push({
                file,
                attribute: attr,
                line: lineOf(file, attr),
                snippet: snippetOf(file, attr),
                enclosing: enclosingFunctionNames(attr),
                ...classify(attr),
              });
            }
          }
        }
      }
      T.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return matches;
}

/**
 * Dependencies for a useMemo/useCallback around `expression`: the names it reads that are
 * declared in the component (its props and locals), minus state setters, in order of first use.
 */
export function dependenciesOf(expression: ts.Expression): string[] {
  const component = innermostNamedFunction(expression);
  if (!component) return [];
  const locals = new Set<string>(component.parameters.flatMap((p) => bindingNames(p.name)));
  const setters = new Set<string>();
  walkBody(component, (node) => {
    if (T.isVariableDeclaration(node)) {
      for (const n of bindingNames(node.name)) locals.add(n);
      if (T.isArrayBindingPattern(node.name) && node.initializer && T.isCallExpression(node.initializer)) {
        const hook = calleeName(node.initializer);
        const second = node.name.elements[1];
        if ((hook === 'useState' || hook === 'useReducer') && second && T.isBindingElement(second) && T.isIdentifier(second.name)) {
          setters.add(second.name.text);
        }
      }
    }
  });
  const own = new Set<string>(); // names declared inside the expression itself (callback parameters, locals)
  const visitDecl = (node: ts.Node): void => {
    if (T.isParameter(node) || T.isVariableDeclaration(node)) for (const n of bindingNames(node.name)) own.add(n);
    T.forEachChild(node, visitDecl);
  };
  visitDecl(expression);
  const deps: string[] = [];
  const add = (name: string): void => {
    if (locals.has(name) && !setters.has(name) && !own.has(name) && !deps.includes(name)) deps.push(name);
  };
  const visit = (node: ts.Node): void => {
    if (T.isShorthandPropertyAssignment(node)) {
      add(node.name.text);
      return;
    }
    if (T.isIdentifier(node)) {
      const parent = node.parent;
      const isName =
        (T.isPropertyAccessExpression(parent) && parent.name === node) ||
        (T.isPropertyAssignment(parent) && parent.name === node) ||
        (T.isJsxAttribute(parent) && parent.name === node);
      if (!isName) add(node.text);
    }
    T.forEachChild(node, visit);
  };
  visit(expression);
  return deps;
}
