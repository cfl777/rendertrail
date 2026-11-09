/**
 * Pure: the two MVP rules (HANDOFF.md §7). Each takes the trace, the steps and the parsed files and
 * returns candidate findings with their cost; thresholds and ranking happen in index.ts.
 *
 * Known limitation (function props): the recorder calls two functions "the same value" when their
 * source text is identical, but two closures with the same text can capture different values. So
 * rule 1 only trusts that for a function prop when the source shows the function is created in the
 * parent's render (an inline arrow or function, or a local one that isn't wrapped in useCallback);
 * otherwise the finding is skipped. A closure that captures a changed value but whose child never
 * calls it during render is still reported, which is right: the child re-rendered for nothing.
 */
import type { Finding, FixKind, InteractionStep, RecordedCommit, RecordedTrace, RenderedComponent, SourceLocation } from '../shared/types.js';
import {
  confirmStateInEffect,
  dependenciesOf,
  findJsxProp,
  lineOf,
  snippetOf,
  textOf,
  type JsxPropMatch,
  type ParsedFile,
} from './source.js';
import { median } from '../recorder/summarize.js';
import { round } from './steps.js';
import { msText, type UnitWords } from './words.js';

/** Timings as medians over the runs. */
export interface Timing {
  commitMs(commit: number): number;
  componentMs(commit: number, rendered: number): number;
}

export interface RuleContext {
  trace: RecordedTrace;
  steps: InteractionStep[];
  files: ParsedFile[];
  timing: Timing;
  unit: UnitWords;
}

export type Candidate = Omit<Finding, 'rank'>;

function stepOfCommit(steps: readonly InteractionStep[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const step of steps) for (const c of step.commits) map.set(c, step.index);
  return map;
}

/** Components that rendered below `rendered[index]` in the commit (render order is depth-first). */
export function descendantsOf(commit: RecordedCommit, index: number): RenderedComponent[] {
  const root = commit.rendered[index];
  if (!root) return [];
  const names = new Set([root.name]);
  const below: RenderedComponent[] = [];
  for (let j = index + 1; j < commit.rendered.length; j += 1) {
    const r = commit.rendered[j]!;
    if (r.parent === null || !names.has(r.parent)) break;
    names.add(r.name);
    below.push(r);
  }
  return below;
}

/** Rule 1's runtime check: a memo component re-rendered and every changed prop kept its value. */
export function isMemoBreak(r: RenderedComponent): boolean {
  return (
    r.memo &&
    r.phase === 'update' &&
    r.changedProps.length > 0 &&
    r.changedState.length === 0 &&
    r.changedContext.length === 0 &&
    r.changedProps.every((p) => p.sameValue)
  );
}

/** Median over all steps of a per-step sum (steps without a hit count as 0). */
function perStepMedian<T extends { step: number }>(steps: readonly InteractionStep[], hits: readonly T[], value: (hit: T) => number): number {
  const sums = new Map<number, number>(steps.map((s) => [s.index, 0]));
  for (const h of hits) sums.set(h.step, (sums.get(h.step) ?? 0) + value(h));
  return median([...sums.values()]);
}

function newThing(type: string): string {
  if (type === 'function') return 'function';
  if (type === 'array') return 'array';
  return 'object';
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function times(n: number): string {
  if (Math.abs(n - 1) < 0.05) return 'one';
  return String(round(n));
}

// ---------------------------------------------------------------------------
// Rule 1: an unstable prop breaks memo
// ---------------------------------------------------------------------------

interface PropSource {
  match: JsxPropMatch | null;
  location: SourceLocation | null;
  fixKind: FixKind;
  fixCode: string | null;
}

/** Where the prop's value is created, and whether the source confirms it's made anew on every render. */
function propSource(ctx: RuleContext, component: string, prop: string, type: string, commit: RecordedCommit): PropSource | null {
  const all = findJsxProp(ctx.files, component, prop);
  const rendered = new Set(commit.rendered.map((r) => r.name));
  const inRendered = all.filter((m) => m.enclosing.some((name) => rendered.has(name)));
  const match = (inRendered.length ? inRendered : all)[0] ?? null;
  const isFunction = type === 'function';
  // Functions are compared by source text, which can't see captured values: only trust it when the
  // source shows a function created in the parent's render (inline, or a local function).
  if (isFunction && (!match || (match.valueKind !== 'inline-function' && match.valueKind !== 'local-function'))) return null;
  if (!match) return { match: null, location: null, fixKind: isFunction ? 'useCallback' : 'useMemo', fixCode: null };

  const local = match.variable !== null && match.valueExpression !== null && match.valueKind.startsWith('local-');
  const where = local ? match.valueExpression! : match.attribute;
  const location: SourceLocation = {
    file: match.file.path,
    line: lineOf(match.file, where),
    snippet: local ? `${match.variable} = ${snippetOf(match.file, where, 80)}` : match.snippet,
  };
  if (match.valueKind === 'memoized') return { match, location, fixKind: 'stabilize-deps', fixCode: null };

  const fixKind: FixKind = isFunction ? 'useCallback' : 'useMemo';
  let fixCode: string | null = null;
  const expr = match.valueExpression;
  if (expr && match.valueKind !== 'local-function' && match.valueKind !== 'prop' && match.valueKind !== 'other') {
    const body = textOf(match.file, expr);
    if (body.length <= 100) {
      const deps = dependenciesOf(expr).join(', ');
      const name = match.variable ?? prop;
      fixCode = isFunction
        ? `const ${name} = useCallback(${body}, [${deps}]);`
        : `const ${name} = useMemo(() => ${body.startsWith('{') ? `(${body})` : body}, [${deps}]);`;
    }
  }
  return { match, location, fixKind, fixCode };
}

export function unstablePropCandidates(ctx: RuleContext): Candidate[] {
  const stepIndex = stepOfCommit(ctx.steps);
  interface Hit {
    commit: number;
    step: number;
    ms: number;
    renders: number;
    below: Record<string, number>;
  }
  const groups = new Map<string, { props: { name: string; type: string }[]; hits: Hit[]; firstCommit: RecordedCommit }>();

  for (const step of ctx.steps) {
    for (const ci of step.commits) {
      const commit = ctx.trace.commits[ci];
      if (!commit) continue;
      commit.rendered.forEach((r, ri) => {
        if (!isMemoBreak(r)) return;
        const below: Record<string, number> = {};
        const descendants = descendantsOf(commit, ri);
        for (const d of descendants) below[d.name] = (below[d.name] ?? 0) + 1;
        const group = groups.get(r.name) ?? { props: [], hits: [], firstCommit: commit };
        for (const p of r.changedProps) if (!group.props.some((g) => g.name === p.name)) group.props.push({ name: p.name, type: p.type });
        // Medians of different numbers can cross; the waste can't exceed the update it's part of.
        const ms = Math.min(ctx.timing.componentMs(ci, ri), ctx.timing.commitMs(ci));
        group.hits.push({ commit: ci, step: stepIndex.get(ci) ?? step.index, ms, renders: 1 + descendants.length, below });
        groups.set(r.name, group);
      });
    }
  }

  const candidates: Candidate[] = [];
  const n = ctx.steps.length;
  for (const [component, group] of groups) {
    const sources = group.props.map((p) => ({ prop: p, source: propSource(ctx, component, p.name, p.type, group.firstCommit) }));
    // Every changed prop must be confirmed, or the render may have been needed (a closure with new values).
    if (sources.some((s) => s.source === null)) continue;
    const confirmed = sources as { prop: { name: string; type: string }; source: PropSource }[];
    const primary = confirmed.find((s) => s.source.location) ?? confirmed[0];
    if (!primary) continue;
    const { prop, source } = primary;
    const others = confirmed.filter((s) => s !== primary).map((s) => s.prop.name);

    const msPerStep = perStepMedian(ctx.steps, group.hits, (h) => h.ms);
    const rendersPerStep = perStepMedian(ctx.steps, group.hits, (h) => h.renders);
    const names = [...new Set(group.hits.flatMap((h) => Object.keys(h.below)))];
    const below = Object.fromEntries(names.map((name) => [name, perStepMedian(ctx.steps, group.hits, (h) => h.below[name] ?? 0)]));
    const stepsAffected = new Set(group.hits.map((h) => h.step)).size;

    const thing = newThing(prop.type);
    const where = source.location ? `${source.location.file}:${source.location.line}` : null;
    const belowText = Object.entries(below)
      .filter(([, k]) => k > 0)
      .map(([name, k]) => `${round(k)} ${name}`)
      .join(', ');
    const how = stepsAffected === n ? `on every ${ctx.unit.one}` : `on ${stepsAffected} of ${count(n, ctx.unit.one)}`;
    const otherText = others.length ? ` (also ${others.map((o) => `\`${o}\``).join(', ')})` : '';

    const hook = source.fixKind === 'useCallback' ? 'useCallback' : 'useMemo';
    const fixShort =
      source.fixKind === 'stabilize-deps'
        ? `it's already memoized, but a dependency changes on every render; make that dependency stable too`
        : `wrap it in ${hook}`;
    const fixLong =
      source.fixKind === 'stabilize-deps'
        ? `\`${prop.name}\` is already wrapped in useMemo or useCallback, but one of its dependencies changes on every render. Make that dependency stable too, so ${component} gets the same ${thing} until its contents change.`
        : `Wrap it in ${hook} so ${component} gets the same ${thing} until its contents change${source.fixCode ? `: \`${source.fixCode}\`${source.match?.variable ? '' : `, then pass \`${prop.name}={${prop.name}}\``}` : ''}.`;

    candidates.push({
      id: `unstable-prop:${component}`,
      rule: 'unstable-prop',
      component,
      prop,
      location: source.location,
      stepsAffected,
      steps: n,
      commits: group.hits.map((h) => h.commit),
      msPerStep,
      rendersPerStep,
      below,
      fix: { kind: source.fixKind, compilerFixes: true },
      texts: {
        summary:
          `${component} (memo) re-renders${belowText ? ` with ${belowText} below it` : ''} ${how}: prop \`${prop.name}\`${otherText} is a new ${thing} each render with the same value` +
          `${where ? `, created at ${where}` : ''}. Wasted: about ${msText(msPerStep)} per ${ctx.unit.one}. Fix: ${fixShort} (React Compiler would do this automatically).`,
        why:
          `memo only skips a render when every prop is the same object as last time. \`${prop.name}\` looks the same, but it's a new ${thing} on every render, ` +
          `so ${component}${belowText ? ` and everything below it` : ''} re-renders for nothing.`,
        line: where ? `\`${source.location!.snippet}\` at ${where}.` : `The line that passes \`${prop.name}\` to ${component} wasn't found in the files.`,
        fix: `${fixLong} React Compiler would do this automatically.`,
      },
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Rule 2: state set inside an effect
// ---------------------------------------------------------------------------

export function stateInEffectCandidates(ctx: RuleContext): Candidate[] {
  const stepIndex = stepOfCommit(ctx.steps);
  const occurrences = new Map<string, { component: string; hook: number; commits: number[] }>();
  const { commits } = ctx.trace;
  for (let ci = 1; ci < commits.length; ci += 1) {
    const commit = commits[ci]!;
    const prev = commits[ci - 1]!;
    if (commit.inputSeq !== prev.inputSeq) continue; // input in between: not a follow-up
    const before = new Set(prev.rendered.map((r) => r.name));
    for (const r of commit.rendered) {
      if (r.phase !== 'update' || !before.has(r.name)) continue;
      for (const s of r.changedState) {
        const key = `${r.name}#${s.hook}`;
        const entry = occurrences.get(key) ?? { component: r.name, hook: s.hook, commits: [] };
        if (!entry.commits.includes(ci)) entry.commits.push(ci);
        occurrences.set(key, entry);
      }
    }
  }

  const byId = new Map<string, Candidate>();
  const n = ctx.steps.length;
  for (const { component, hook, commits: hits } of occurrences.values()) {
    const source = confirmStateInEffect(ctx.files, component, hook);
    if (!source) continue;
    const inSteps = hits.filter((c) => stepIndex.has(c));
    const stepsAffected = new Set(inSteps.map((c) => stepIndex.get(c))).size;
    const extra = n ? inSteps.length / n : 0;
    const inStepHits = inSteps.map((c) => ({ step: stepIndex.get(c)!, ms: ctx.timing.commitMs(c), renders: commits[c]?.rendered.length ?? 0 }));
    const msPerStep = perStepMedian(ctx.steps, inStepHits, (h) => h.ms);
    const rendersPerStep = perStepMedian(ctx.steps, inStepHits, (h) => h.renders);
    const location: SourceLocation = { file: source.file.path, line: lineOf(source.file, source.call), snippet: snippetOf(source.file, source.call) };
    const where = `${location.file}:${location.line}`;
    const inHook = source.owner !== component ? ` (in ${source.owner})` : '';
    const arg = source.call.arguments.length === 1 ? source.call.arguments[0]! : null;
    const plainArg = arg && !arg.getText(source.file.source).includes('=>') && !/^function\b/.test(arg.getText(source.file.source));
    const code = source.state && plainArg ? `const ${source.state} = ${textOf(source.file, arg)};` : null;
    const stateWord = source.state ? `\`${source.state}\`` : 'the value';
    const id = `state-in-effect:${component}:${source.setter}`;
    const how = stepsAffected === n ? `per ${ctx.unit.one}` : `on ${stepsAffected} of ${count(n, ctx.unit.one)}`;
    const extraText = stepsAffected === n ? `${times(extra)} extra update ${how}` : `an extra update ${how}`;

    const candidate: Candidate = {
      id,
      rule: 'state-in-effect',
      component,
      hook: { index: hook, state: source.state, setter: source.setter, owner: source.owner },
      location,
      stepsAffected,
      steps: n,
      commits: hits,
      msPerStep,
      rendersPerStep,
      extraUpdatesPerStep: round(extra),
      fix: { kind: 'compute-in-render', compilerFixes: false },
      texts: {
        summary:
          `${component} sets state inside ${source.effect}${inHook} (${where}): ${extraText} (${msText(msPerStep)}). ` +
          `Fix: compute ${source.state ?? 'it'} during render${code ? `: \`${code}\`` : ''}. React Compiler doesn't fix this one.`,
        why:
          `${component} copies a value into state inside ${source.effect}. React renders ${component}, runs the effect, ` +
          `and then has to render it again with the new ${source.state ?? 'state'}: two updates where one would do.`,
        line: `\`${location.snippet}\` at ${where}${inHook}.`,
        fix: code
          ? `Compute ${stateWord} during render instead: \`${code}\`, and remove its useState and the ${source.effect}. React Compiler doesn't fix this one.`
          : `Compute ${stateWord} during render instead of storing it in state from ${source.effect}. React Compiler doesn't fix this one.`,
      },
    };
    const existing = byId.get(id);
    if (!existing || existing.msPerStep < candidate.msPerStep) byId.set(id, candidate);
  }
  return [...byId.values()];
}
