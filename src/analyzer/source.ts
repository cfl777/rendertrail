/**
 * Pure: read the files Claude sent with the TypeScript compiler API (`ts.createSourceFile`, syntax
 * only, no type checking) to confirm findings and find the line to change (HANDOFF.md §7).
 * Everything here works on names: components and custom hooks are matched by function name across
 * all files, not by following imports.
 */
import path from 'node:path';
import ts from 'typescript';
import { findAliased, findFile, normalizePath } from '../recorder/paths.js';

export interface ParsedFile {
  path: string;
  source: ts.SourceFile;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

export function parseFiles(files: readonly { path: string; content: string }[]): ParsedFile[] {
  return files
    .filter((file) => SCRIPT.test(file.path))
    .map((file) => ({
      path: file.path,
      source: ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, kindOf(file.path)),
    }));
}

function kindOf(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/.test(lower)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX; // .js files often hold JSX too
}

/** Import specifiers in a file: import/export … from, import(), require(). */
function importSpecifiers(file: ParsedFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) specs.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return specs;
}

/**
 * The files the entry pulls in, directly or through other files (what the bundle contains). Files
 * that aren't imported can't have rendered, so the analyzer ignores them. All files when the entry
 * isn't among them.
 */
export function reachableFrom(files: readonly ParsedFile[], entry: string): ParsedFile[] {
  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]));
  const keys = new Map(files.map((f) => [normalizePath(f.path), '']));
  const start = findFile(keys, entry);
  if (!start) return [...files];
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    const file = byPath.get(current);
    if (!file) continue;
    for (const spec of importSpecifiers(file)) {
      const found = spec.startsWith('.') || spec.startsWith('/')
        ? findFile(keys, spec.startsWith('/') ? spec : path.posix.join(path.posix.dirname(current), spec))
        : findAliased(keys, spec);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return files.filter((f) => seen.has(normalizePath(f.path)));
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

export function lineOf(file: ParsedFile, node: ts.Node): number {
  return file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1;
}

export function snippetOf(file: ParsedFile, node: ts.Node, max = 90): string {
  const text = node.getText(file.source).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Name of a function as React would show it: its own name, or the variable it's assigned to (through memo/forwardRef). */
export function functionName(node: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
  let parent: ts.Node = node.parent;
  while (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) parent = parent.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** Every function in the files whose name (see functionName) is `name`. */
export function findFunctions(files: readonly ParsedFile[], name: string): { file: ParsedFile; fn: FunctionLike }[] {
  const found: { file: ParsedFile; fn: FunctionLike }[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node) && functionName(node) === name) found.push({ file, fn: node });
      ts.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return found;
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
    ts.forEachChild(node, walk);
    if (order === 'post') visit(node);
  };
  if (fn.body) walk(fn.body);
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text; // React.useState
  return null;
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
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name) || name === 'use';
}

function findHookDefinition(files: readonly ParsedFile[], name: string): { file: ParsedFile; fn: FunctionLike } | null {
  const found = findFunctions(files, name);
  return found.length === 1 ? found[0]! : null;
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
        if (!ts.isCallExpression(node)) return;
        const name = calleeName(node);
        if (!name || !isHookName(name)) return;
        if (name in BUILTIN_HOOK_SLOTS) {
          const slots: number | null = BUILTIN_HOOK_SLOTS[name] ?? null;
          if (slots === 0) return;
          const binding = ts.isVariableDeclaration(node.parent) && ts.isArrayBindingPattern(node.parent.name) ? node.parent.name : null;
          const element = (i: number): string | null => {
            const el = binding?.elements[i];
            return el && ts.isBindingElement(el) && ts.isIdentifier(el.name) ? el.name.text : null;
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
          });
          next = slots === null || next === null ? null : next + slots;
          return;
        }
        const definition = depth < MAX_HOOK_DEPTH ? findHookDefinition(files, name) : null;
        if (!definition || stack.has(definition.fn)) {
          next = null; // a hook we can't see: its size is unknown
          return;
        }
        stack.add(definition.fn);
        expand(definition.file, definition.fn, depth + 1, stack);
        stack.delete(definition.fn);
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
    if (!ts.isCallExpression(node)) return;
    const effect = calleeName(node);
    if (!effect || !EFFECT_HOOKS.has(effect)) return;
    const callback = node.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
    const check = (inner: ts.Node): void => {
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && setters.has(inner.expression.text)) {
        calls.push({ setter: inner.expression.text, call: inner, effect, file, owner: functionName(owner) ?? 'anonymous' });
      }
    };
    walkBody(callback, check);
  });
  return calls;
}

export interface StateInEffectSource {
  state: string | null;
  setter: string;
  owner: string;
  /** The setter call in the effect. */
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
    const byIndex = hooks.find((h) => h.index === hookIndex);
    if (byIndex) {
      if (!byIndex.setter) continue; // the index points at a hook that isn't useState/useReducer
      const calls = syncSetterCallsInEffects(byIndex.owner.file, byIndex.owner.fn, new Set([byIndex.setter]));
      const first = calls[0];
      if (!first) return null; // set elsewhere (a timer, a handler): not this rule
      return { state: byIndex.state, setter: byIndex.setter, owner: byIndex.owner.name, file: first.file, call: first.call, effect: first.effect, matchedByIndex: true };
    }
    // Ambiguous: fall back to the only setter called synchronously in an effect.
    const owners = new Map<FunctionLike, { file: ParsedFile; setters: Set<string> }>();
    for (const h of stateHooks) {
      const entry = owners.get(h.owner.fn) ?? { file: h.owner.file, setters: new Set<string>() };
      entry.setters.add(h.setter!);
      owners.set(h.owner.fn, entry);
    }
    const calls = [...owners.entries()].flatMap(([owner, { file: ownerFile, setters }]) => syncSetterCallsInEffects(ownerFile, owner, setters));
    const setters = new Set(calls.map((c) => c.setter));
    const only = calls[0];
    if (setters.size === 1 && only) {
      const hook = stateHooks.find((h) => h.setter === only.setter);
      return { state: hook?.state ?? null, setter: only.setter, owner: only.owner, file: only.file, call: only.call, effect: only.effect, matchedByIndex: false };
    }
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
}

function tagMatches(tag: ts.JsxTagNameExpression, component: string): boolean {
  if (ts.isIdentifier(tag)) return tag.text === component;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text === component;
  return false;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function literalKind(expr: ts.Expression, scope: 'inline' | 'local'): PropValueKind | null {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return `${scope}-object`;
  if (ts.isArrayLiteralExpression(e)) return `${scope}-array`;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return `${scope}-function`;
  if (ts.isCallExpression(e)) {
    const name = calleeName(e);
    if (name === 'useMemo' || name === 'useCallback') return 'memoized';
  }
  return null;
}

/** Names bound by a binding pattern or identifier. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isBindingElement(el) ? bindingNames(el.name) : []));
}

function classify(attribute: ts.JsxAttribute): { kind: PropValueKind; expression: ts.Expression | null; variable: string | null } {
  const init = attribute.initializer;
  const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
  if (!expr) return { kind: 'other', expression: null, variable: null };
  const inline = literalKind(expr, 'inline');
  if (inline) return { kind: inline, expression: unwrap(expr), variable: null };
  const target = unwrap(expr);
  if (!ts.isIdentifier(target)) return { kind: 'other', expression: target, variable: null };
  const name = target.text;
  // Look the name up in the functions around the element, innermost first.
  for (let scope: ts.Node | undefined = attribute.parent; scope; scope = scope.parent) {
    if (!isFunctionLike(scope)) continue;
    if (scope.parameters.some((p) => bindingNames(p.name).includes(name))) return { kind: 'prop', expression: null, variable: name };
    const found: { value: { kind: PropValueKind; expression: ts.Expression | null } | null } = { value: null };
    walkBody(scope, (node) => {
      if (found.value) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        found.value = { kind: literalKind(node.initializer, 'local') ?? 'other', expression: unwrap(node.initializer) };
      }
    });
    // Function declarations inside the component are recreated on every render too.
    const body = scope.body;
    if (!found.value && body && ts.isBlock(body)) {
      const decl = body.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
      if (decl) found.value = { kind: 'local-function', expression: null };
    }
    if (found.value) return { ...found.value, variable: name };
  }
  return { kind: 'other', expression: null, variable: name }; // module level, or not found
}

/** JSX elements `<Component prop=…>` in the files, with where their value comes from. */
export function findJsxProp(files: readonly ParsedFile[], component: string, prop: string): JsxPropMatch[] {
  const matches: JsxPropMatch[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && tagMatches(node.tagName, component)) {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === prop) {
            const { kind, expression, variable } = classify(attr);
            matches.push({
              file,
              attribute: attr,
              line: lineOf(file, attr),
              snippet: snippetOf(file, attr),
              enclosing: enclosingFunctionNames(attr),
              valueKind: kind,
              valueExpression: expression,
              variable,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
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
    if (ts.isVariableDeclaration(node)) {
      for (const n of bindingNames(node.name)) locals.add(n);
      if (ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const hook = calleeName(node.initializer);
        const second = node.name.elements[1];
        if ((hook === 'useState' || hook === 'useReducer') && second && ts.isBindingElement(second) && ts.isIdentifier(second.name)) {
          setters.add(second.name.text);
        }
      }
    }
  });
  const own = new Set<string>(); // names declared inside the expression itself (callback parameters, locals)
  const visitDecl = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) for (const n of bindingNames(node.name)) own.add(n);
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(expression);
  const deps: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isShorthandPropertyAssignment(node)) {
      add(node.name.text);
      return;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isJsxAttribute(parent) && parent.name === node);
      if (!isName) add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  const add = (name: string): void => {
    if (locals.has(name) && !setters.has(name) && !own.has(name) && !deps.includes(name)) deps.push(name);
  };
  visit(expression);
  return deps;
}

export function textOf(file: ParsedFile, node: ts.Node): string {
  return node.getText(file.source).replace(/\s+/g, ' ').trim();
}
