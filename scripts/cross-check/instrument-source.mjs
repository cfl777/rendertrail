// Independent render counter for the fixtures cross-check (scripts/cross-check-fixtures.mjs).
// Rewrites a fixture source file so that every function component calls
// `globalThis.__xc.render('Name')` as the first statement of its body. It uses the TypeScript
// parser only (no type checking) and has nothing to do with the recorder or bippy.
//
// What counts as a function component here:
// - a module-level `function Name() {}` (exported or not, `export default` included);
// - a module-level `const Name = function () {}` or `const Name = () => ...`;
// - a function passed to `memo()` / `forwardRef()` (also `React.memo`, nested `memo(forwardRef(...))`)
//   at module level, in a `const` or in `export default`.
// The name must start with a capital letter. Hooks (`useX`) and helpers (`busyWait`) are lowercase,
// so they are never counted.
//
// The name is the one React DevTools shows: for `const X = memo(function Y() {})` that is `Y` (the
// inner function's name); for `const X = memo(() => ...)` DevTools would show "Anonymous", so the
// variable name is used and the component is flagged `anonymousInDevTools`.
import ts from 'typescript';

const WRAPPERS = new Set(['memo', 'forwardRef']);

/** @param {string} name */
function isComponentName(name) {
  return /^[A-Z]/.test(name);
}

/**
 * `memo` / `forwardRef` / `React.memo` / `React.forwardRef`.
 * @param {ts.Expression} callee
 */
function isWrapperCallee(callee) {
  if (ts.isIdentifier(callee)) return WRAPPERS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return WRAPPERS.has(callee.name.text);
  return false;
}

/**
 * Peel `memo(...)` / `forwardRef(...)` calls (and parentheses) down to a function, if there is one.
 * @param {ts.Expression} expr
 * @returns {{ fn: ts.FunctionExpression | ts.ArrowFunction, wrapped: boolean } | undefined}
 */
function unwrapComponent(expr) {
  let current = expr;
  let wrapped = false;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current) && isWrapperCallee(current.expression) && current.arguments[0]) {
      current = current.arguments[0];
      wrapped = true;
    } else {
      break;
    }
  }
  if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return { fn: current, wrapped };
  return undefined;
}

/**
 * @typedef {{ name: string, line: number, wrapped: boolean, anonymousInDevTools: boolean }} FoundComponent
 * @typedef {{ at: number, text: string }} Insertion
 */

/**
 * @param {string} source
 * @param {string} fileName used for the parser's language choice (.ts or .tsx) and in messages
 * @returns {{ code: string, components: FoundComponent[] }}
 */
export function instrumentComponents(source, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  /** @type {Insertion[]} */
  const insertions = [];
  /** @type {FoundComponent[]} */
  const components = [];

  /**
   * @param {string} name
   * @param {ts.FunctionLikeDeclaration} fn
   * @param {boolean} wrapped
   * @param {boolean} anonymousInDevTools
   */
  function add(name, fn, wrapped, anonymousInDevTools) {
    if (!isComponentName(name) || !fn.body) return;
    const call = `globalThis.__xc.render(${JSON.stringify(name)});`;
    if (ts.isBlock(fn.body)) {
      insertions.push({ at: fn.body.getStart(sf) + 1, text: ` ${call}` });
    } else {
      // Arrow with an expression body: turn it into a block that returns the expression.
      insertions.push({ at: fn.body.getStart(sf), text: `{ ${call} return (` });
      insertions.push({ at: fn.body.getEnd(), text: '); }' });
    }
    const line = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
    components.push({ name, line, wrapped, anonymousInDevTools });
  }

  /**
   * @param {ts.Expression} expr
   * @param {string | undefined} bindingName
   */
  function fromExpression(expr, bindingName) {
    const found = unwrapComponent(expr);
    if (!found) return;
    const own = ts.isFunctionExpression(found.fn) && found.fn.name ? found.fn.name.text : undefined;
    if (own) {
      add(own, found.fn, found.wrapped, false);
    } else if (bindingName) {
      // `const X = () => ...` gets the name X from JavaScript itself; `memo(() => ...)` doesn't.
      add(bindingName, found.fn, found.wrapped, found.wrapped);
    }
  }

  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
      const name = statement.name?.text ?? (isDefault ? 'Anonymous' : undefined);
      if (name) add(name, statement, false, !statement.name);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) fromExpression(decl.initializer, decl.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      fromExpression(statement.expression, undefined);
    }
  }

  insertions.sort((a, b) => b.at - a.at);
  let code = source;
  for (const { at, text } of insertions) code = code.slice(0, at) + text + code.slice(at);
  return { code, components };
}
