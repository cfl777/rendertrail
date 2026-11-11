/**
 * Pure: the two MVP rules (HANDOFF.md §7). Each takes the trace, the steps and the parsed files and
 * returns candidate findings with their cost; thresholds and ranking happen in index.ts.
 *
 * Known limitations:
 * - Function props: the recorder calls two functions "the same value" when their source text is
 *   identical, but two closures with the same text can capture different values. So rule 1 only
 *   trusts that for a function prop when the source shows the function is created in a render (an
 *   inline arrow or function, or a local one that isn't wrapped in useCallback), possibly passed
 *   down through props; otherwise the finding is skipped. A closure that captures a changed value
 *   but whose child never calls it during render is still reported, which is right: the child
 *   re-rendered for nothing.
 * - Rule 2 only sees a setter called directly in the effect's own body. Not detected: an effect
 *   whose callback is a local function (`useEffect(sync, [v])`), and a setter called inside another
 *   callback that runs synchronously (`xs.forEach((x) => setN(x))`).
 * - Rule 2's cost is the time of the component's own re-render in the extra update (its subtree),
 *   so two components setting state in the same update each carry only their part.
 */
import type { Finding, FixKind, InteractionStep, RecordedCommit, RecordedTrace, RenderedComponent, SourceLocation } from '../shared/types.js';
import { median } from '../recorder/summarize.js';
import {
  confirmStateInEffect,
  dependenciesOf,
  findJsxProp,
  lineOf,
  snippetOf,
  textOf,
  type JsxPropMatch,
  type ParsedFile,
  type PropValueKind,
} from './source.js';
import { round } from './steps.js';
import { msText, type UnitWords } from './words.js';

/** Timings as medians over the runs. */
export interface Timing {
  commitMs(commit: number): number;
  componentMs(commit: number, rendered: number): number;
  /**
   * A component's part of its commit's time: the commit's median time × the median share of the
   * commit that component (with everything below it) took. Both come from the same per-run
   * numbers, so it never exceeds the commit and the rest of the commit stays visible.
   */
  componentShareMs(commit: number, rendered: number): number;
}

export interface RuleContext {
  trace: RecordedTrace;
  steps: InteractionStep[];
  files: ParsedFile[];
  timing: Timing;
  unit: UnitWords;
}

export type Candidate = Omit<Finding, 'rank'>;

/** How far rule 1 follows a prop up through components that only pass it along. */
const MAX_PROP_HOPS = 3;

function stepOfCommit(steps: readonly InteractionStep[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const step of steps) for (const c of step.commits) map.set(c, step.index);
  return map;
}

/** True when `rendered[index]` is below `rendered[ancestor]` in the commit. */
function isBelow(commit: RecordedCommit, index: number, ancestor: number): boolean {
  for (let p = commit.rendered[index]?.parentIndex ?? null; p !== null; p = commit.rendered[p]?.parentIndex ?? null) {
    if (p === ancestor) return true;
  }
  return false;
}

/** Components that rendered below `rendered[index]` in the commit (render order is depth-first, so the subtree is contiguous). */
export function descendantsOf(commit: RecordedCommit, index: number): RenderedComponent[] {
  if (!commit.rendered[index]) return [];
  const inside = new Set([index]);
  const below: RenderedComponent[] = [];
  for (let j = index + 1; j < commit.rendered.length; j += 1) {
    const r = commit.rendered[j]!;
    if (r.parentIndex === null || !inside.has(r.parentIndex)) break;
    inside.add(j);
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

interface Hit {
  commit: number;
  step: number;
  ms: number;
  renders: number;
  below: Record<string, number>;
}

/** Per-step sums for the steps a finding happened on. */
function perAffectedStep(hits: readonly Hit[], value: (hit: Hit) => number): number[] {
  const sums = new Map<number, number>();
  for (const h of hits) sums.set(h.step, (sums.get(h.step) ?? 0) + value(h));
  return [...sums.values()];
}

/** Mean over all steps (total / steps) and median over the affected steps. */
function costs(hits: readonly Hit[], steps: number, value: (hit: Hit) => number): { mean: number; affected: number } {
  const sums = perAffectedStep(hits, value);
  const total = sums.reduce((a, b) => a + b, 0);
  return { mean: steps ? round(total / steps) : 0, affected: median(sums) };
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

/** "about 20 ms per letter" when it happened on every step, "on 2 of 5 letters, about 40 ms each" otherwise. */
function costText(ms: number, affected: number, steps: number, unit: UnitWords): string {
  return affected === steps ? `about ${msText(ms)} per ${unit.one}` : `on ${affected} of ${count(steps, unit.one, unit.many)}, about ${msText(ms)} each`;
}

// ---------------------------------------------------------------------------
// Rule 1: an unstable prop breaks memo
// ---------------------------------------------------------------------------

interface PropSource {
  location: SourceLocation | null;
  /** Other places that pass the prop to the same component. */
  others: SourceLocation[];
  fixKind: FixKind;
  fixCode: string | null;
  /** The local variable that holds the value where it's created, if any. */
  variable: string | null;
  /** Components the value is passed through on its way down (innermost first). */
  via: string[];
  /** Set when the value comes from props further up than the files show: that component's name. */
  passedInto: string | null;
  /** The variable the suggested fix introduces, when the value was inline. */
  newVariable: string | null;
}

/** Inline values first: they're the ones made anew on every render. Memoized ones last. */
const KIND_ORDER: Record<PropValueKind, number> = {
  'inline-object': 0,
  'inline-array': 0,
  'inline-function': 0,
  'local-object': 1,
  'local-array': 1,
  'local-function': 1,
  prop: 2,
  other: 3,
  memoized: 4,
};

function pick(matches: JsxPropMatch[], rendered: ReadonlySet<string>): { best: JsxPropMatch | null; rest: JsxPropMatch[] } {
  const inRendered = matches.filter((m) => m.enclosing.some((name) => rendered.has(name)));
  const pool = (inRendered.length ? inRendered : matches).slice().sort((a, b) => KIND_ORDER[a.valueKind] - KIND_ORDER[b.valueKind]);
  const best = pool[0] ?? null;
  return { best, rest: matches.filter((m) => m !== best) };
}

function attributeLocation(m: JsxPropMatch): SourceLocation {
  return { file: m.file.path, line: m.line, snippet: m.snippet };
}

/** Where the prop's value is created, and whether the source confirms it's made anew on every render. */
function propSource(ctx: RuleContext, component: string, prop: string, type: string, commit: RecordedCommit): PropSource | null {
  const rendered = new Set(commit.rendered.map((r) => r.name));
  const isFunction = type === 'function';
  const hook: FixKind = isFunction ? 'useCallback' : 'useMemo';
  const { best, rest } = pick(findJsxProp(ctx.files, component, prop), rendered);
  const others = rest.map(attributeLocation);
  if (!best) return isFunction ? null : { location: null, others, fixKind: hook, fixCode: null, variable: null, via: [], passedInto: null, newVariable: null };

  // Follow a value that only passes through props up to where it's created.
  let origin = best;
  const via: string[] = [];
  for (let hop = 0; hop < MAX_PROP_HOPS && origin.valueKind === 'prop' && origin.fromProp; hop += 1) {
    via.push(origin.fromProp.component);
    const up = pick(findJsxProp(ctx.files, origin.fromProp.component, origin.fromProp.prop), rendered).best;
    if (!up) break;
    origin = up;
  }
  const resolved = origin.valueKind !== 'prop';
  // Functions are compared by source text, which can't see captured values: only trust it when the
  // source shows a function created in a render (inline, or a local function).
  if (isFunction && !(resolved && (origin.valueKind === 'inline-function' || origin.valueKind === 'local-function'))) return null;
  if (!resolved) {
    const into = via.at(-1) ?? origin.enclosing[0] ?? component;
    return { location: attributeLocation(best), others, fixKind: hook, fixCode: null, variable: null, via, passedInto: into, newVariable: null };
  }

  const local = origin.variable !== null && origin.valueExpression !== null && origin.valueKind.startsWith('local-');
  const where = local ? origin.valueExpression! : origin.attribute;
  const location: SourceLocation = {
    file: origin.file.path,
    line: lineOf(origin.file, where),
    snippet: local ? `${origin.variable} = ${snippetOf(origin.file, where, 80)}` : origin.snippet,
  };
  const base = { location, others, variable: origin.variable, via, passedInto: null, newVariable: null };
  if (origin.valueKind === 'memoized') return { ...base, fixKind: 'stabilize-deps', fixCode: null };

  let fixCode: string | null = null;
  let newVariable: string | null = null;
  const expr = origin.valueExpression;
  if (expr && origin.valueKind !== 'local-function' && origin.valueKind !== 'other') {
    const body = textOf(origin.file, expr);
    if (body.length <= 100) {
      const deps = dependenciesOf(expr).join(', ');
      const name = origin.variable ?? origin.attribute.name.getText(origin.file.source);
      if (!origin.variable) newVariable = name;
      fixCode = isFunction
        ? `const ${name} = useCallback(${body}, [${deps}]);`
        : `const ${name} = useMemo(() => ${body.startsWith('{') ? `(${body})` : body}, [${deps}]);`;
    }
  }
  return { ...base, fixKind: hook, fixCode, newVariable };
}

export function unstablePropCandidates(ctx: RuleContext): Candidate[] {
  const stepIndex = stepOfCommit(ctx.steps);
  const groups = new Map<string, { props: { name: string; type: string }[]; hits: Hit[]; firstCommit: RecordedCommit }>();

  for (const step of ctx.steps) {
    for (const ci of step.commits) {
      const commit = ctx.trace.commits[ci];
      if (!commit) continue;
      const hitIndexes = new Map<string, number[]>(); // per component, in this commit
      commit.rendered.forEach((r, ri) => {
        if (!isMemoBreak(r)) return;
        // A nested instance (a memo tree rendering itself) is already inside its ancestor's time.
        const seen = hitIndexes.get(r.name) ?? [];
        if (seen.some((a) => isBelow(commit, ri, a))) return;
        hitIndexes.set(r.name, [...seen, ri]);
        const below: Record<string, number> = {};
        const descendants = descendantsOf(commit, ri);
        for (const d of descendants) below[d.name] = (below[d.name] ?? 0) + 1;
        const group = groups.get(r.name) ?? { props: [], hits: [], firstCommit: commit };
        for (const p of r.changedProps) if (!group.props.some((g) => g.name === p.name)) group.props.push({ name: p.name, type: p.type });
        group.hits.push({ commit: ci, step: stepIndex.get(ci) ?? step.index, ms: ctx.timing.componentShareMs(ci, ri), renders: 1 + descendants.length, below });
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
    const primary = confirmed.find((s) => s.source.location && !s.source.passedInto) ?? confirmed.find((s) => s.source.location) ?? confirmed[0];
    if (!primary) continue;
    const { prop, source } = primary;
    const otherProps = confirmed.filter((s) => s !== primary).map((s) => s.prop.name);

    const ms = costs(group.hits, n, (h) => h.ms);
    const renders = costs(group.hits, n, (h) => h.renders);
    const names = [...new Set(group.hits.flatMap((h) => Object.keys(h.below)))];
    const below = Object.fromEntries(names.map((name) => [name, median(perAffectedStep(group.hits, (h) => h.below[name] ?? 0))]));
    const stepsAffected = new Set(group.hits.map((h) => h.step)).size;
    const everyStep = stepsAffected === n;

    const thing = newThing(prop.type);
    const where = source.location ? `${source.location.file}:${source.location.line}` : null;
    const belowText = Object.entries(below)
      .filter(([, k]) => k > 0)
      .map(([name, k]) => `${round(k)} ${name}`)
      .join(', ');
    const how = everyStep ? `on every ${ctx.unit.one}` : `on some ${ctx.unit.many}`;
    const otherText = otherProps.length ? ` (also ${otherProps.map((o) => `\`${o}\``).join(', ')})` : '';
    const viaText = source.via.length && !source.passedInto ? ` and passed down through ${source.via.join(', ')}` : '';
    const alsoText = source.others.length ? ` It is also passed at ${source.others.map((o) => `${o.file}:${o.line}`).join(', ')}.` : '';
    const hookName = source.fixKind === 'useCallback' ? 'useCallback' : 'useMemo';

    let createdText: string;
    let fixShort: string;
    let fixLong: string;
    if (source.passedInto) {
      createdText = where ? `, passed in from ${source.passedInto}'s parent (${where})` : '';
      fixShort = `make it stable where it is created, above ${source.passedInto} (${hookName})`;
      fixLong = `\`${prop.name}\` is passed in from ${source.passedInto}'s parent, and the files don't show where it is created. Make it stable where it is created, with ${hookName}, so ${component} gets the same ${thing} until its contents change.`;
    } else if (source.fixKind === 'stabilize-deps') {
      createdText = where ? `, created at ${where}${viaText}` : '';
      fixShort = `it's already memoized, but a dependency changes on every render; make that dependency stable too`;
      fixLong = `\`${prop.name}\` is already wrapped in useMemo or useCallback, but one of its dependencies changes on every render. Make that dependency stable too, so ${component} gets the same ${thing} until its contents change.`;
    } else {
      createdText = where ? `, created at ${where}${viaText}` : '';
      fixShort = `wrap it in ${hookName}`;
      const passHint = source.fixCode && source.newVariable ? `, then pass \`${source.newVariable}={${source.newVariable}}\`` : '';
      fixLong = `Wrap it in ${hookName} so ${component} gets the same ${thing} until its contents change${source.fixCode ? `: \`${source.fixCode}\`${passHint}` : ''}.`;
    }

    candidates.push({
      id: `unstable-prop:${component}:${prop.name}`,
      rule: 'unstable-prop',
      component,
      prop,
      location: source.location,
      ...(source.others.length ? { otherLocations: source.others } : {}),
      stepsAffected,
      steps: n,
      commits: group.hits.map((h) => h.commit),
      msPerStep: ms.mean,
      msPerAffectedStep: ms.affected,
      rendersPerStep: renders.mean,
      rendersPerAffectedStep: renders.affected,
      below,
      fix: { kind: source.fixKind, compilerFixes: true },
      texts: {
        summary:
          `${component} (memo) re-renders${belowText ? ` with ${belowText} below it` : ''} ${how}: prop \`${prop.name}\`${otherText} is a new ${thing} each render with the same value` +
          `${createdText}. Wasted: ${costText(ms.affected, stepsAffected, n, ctx.unit)}. Fix: ${fixShort} (React Compiler would do this automatically).${alsoText}`,
        why:
          `memo only skips a render when every prop is the same object as last time. \`${prop.name}\` looks the same, but it's a new ${thing} on every render, ` +
          `so ${component}${belowText ? ` and everything below it` : ''} re-renders for nothing.`,
        line: where
          ? `\`${source.location!.snippet}\` at ${where}${source.passedInto ? ` (it comes from ${source.passedInto}'s props)` : ''}.${alsoText}`
          : `The line that passes \`${prop.name}\` to ${component} wasn't found in the files.`,
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
  interface Occurrence {
    component: string;
    hook: number;
    /** Per commit: the component's own re-render (its subtree), time and renders. */
    perCommit: Map<number, { ms: number; renders: number }>;
  }
  const occurrences = new Map<string, Occurrence>();
  const { commits } = ctx.trace;
  for (let ci = 1; ci < commits.length; ci += 1) {
    const commit = commits[ci]!;
    const prev = commits[ci - 1]!;
    if (commit.inputSeq !== prev.inputSeq) continue; // input in between: not a follow-up
    const before = new Set(prev.rendered.map((r) => r.name));
    commit.rendered.forEach((r, ri) => {
      if (r.phase !== 'update' || !before.has(r.name)) return;
      for (const s of r.changedState) {
        const key = `${r.name}#${s.hook}`;
        const entry = occurrences.get(key) ?? { component: r.name, hook: s.hook, perCommit: new Map() };
        const cost = entry.perCommit.get(ci) ?? { ms: 0, renders: 0 };
        cost.ms += ctx.timing.componentShareMs(ci, ri);
        cost.renders += 1 + descendantsOf(commit, ri).length;
        entry.perCommit.set(ci, cost);
        occurrences.set(key, entry);
      }
    });
  }

  const byId = new Map<string, Candidate>();
  const n = ctx.steps.length;
  for (const { component, hook, perCommit } of occurrences.values()) {
    const source = confirmStateInEffect(ctx.files, component, hook);
    if (!source) continue;
    const hits = [...perCommit.keys()];
    const inStepHits: Hit[] = hits
      .filter((c) => stepIndex.has(c))
      .map((c) => ({ commit: c, step: stepIndex.get(c)!, ms: round(perCommit.get(c)!.ms), renders: perCommit.get(c)!.renders, below: {} }));
    const stepsAffected = new Set(inStepHits.map((h) => h.step)).size;
    const extra = n ? inStepHits.length / n : 0;
    const ms = costs(inStepHits, n, (h) => h.ms);
    const renders = costs(inStepHits, n, (h) => h.renders);
    const location: SourceLocation = { file: source.file.path, line: lineOf(source.file, source.call), snippet: snippetOf(source.file, source.call) };
    const where = `${location.file}:${location.line}`;
    const inHook = source.owner !== component ? ` (in ${source.owner})` : '';
    const isReducer = source.hook === 'useReducer';
    const arg = source.call.arguments.length === 1 ? source.call.arguments[0]! : null;
    const argText = arg ? arg.getText(source.file.source) : '';
    const plainArg = arg !== null && !argText.includes('=>') && !/^function\b/.test(argText);
    const code = !isReducer && source.state && arg && plainArg ? `const ${source.state} = ${textOf(source.file, arg)};` : null;
    const stateWord = source.state ? `\`${source.state}\`` : 'the value';
    const id = `state-in-effect:${component}:${source.setter}`;
    const extraText =
      stepsAffected === n
        ? `${times(extra)} extra update per ${ctx.unit.one} (${msText(ms.affected)})`
        : `an extra update on ${stepsAffected} of ${count(n, ctx.unit.one, ctx.unit.many)} (${msText(ms.affected)} each)`;
    const fixShort = isReducer
      ? `derive ${source.state ?? 'it'} during render instead of dispatching from ${source.effect}`
      : `compute ${source.state ?? 'it'} during render${code ? `: \`${code}\`` : ''}`;
    const fixLong = isReducer
      ? `Derive ${stateWord} during render instead of dispatching from ${source.effect}, and drop that dispatch.`
      : code
        ? `Compute ${stateWord} during render instead: \`${code}\`, and remove its useState and the ${source.effect}.`
        : `Compute ${stateWord} during render instead of storing it in state from ${source.effect}.`;

    const candidate: Candidate = {
      id,
      rule: 'state-in-effect',
      component,
      hook: { index: hook, state: source.state, setter: source.setter, owner: source.owner },
      location,
      stepsAffected,
      steps: n,
      commits: hits,
      msPerStep: ms.mean,
      msPerAffectedStep: ms.affected,
      rendersPerStep: renders.mean,
      rendersPerAffectedStep: renders.affected,
      extraUpdatesPerStep: round(extra),
      fix: { kind: 'compute-in-render', compilerFixes: false },
      texts: {
        summary: `${component} ${isReducer ? 'dispatches to its reducer' : 'sets state'} inside ${source.effect}${inHook} (${where}): ${extraText}. Fix: ${fixShort}. React Compiler doesn't fix this one.`,
        why:
          `${component} ${isReducer ? 'updates its reducer state' : 'copies a value into state'} inside ${source.effect}. React renders ${component}, runs the effect, ` +
          `and then has to render it again with the new ${source.state ?? 'state'}: two updates where one would do.`,
        line: `\`${location.snippet}\` at ${where}${inHook}.`,
        fix: `${fixLong} React Compiler doesn't fix this one.`,
      },
    };
    const existing = byId.get(id);
    if (!existing || existing.msPerStep < candidate.msPerStep) byId.set(id, candidate);
  }
  return [...byId.values()];
}
