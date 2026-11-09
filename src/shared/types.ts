/**
 * Tool input/output and trace types shared by the server, the recorder and the card.
 * Bump SCHEMA_VERSION on any breaking change to these shapes.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// inspect_render input (HANDOFF.md §5)
// ---------------------------------------------------------------------------

export const StepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('type'),
    target: z.string(),
    text: z.string(),
    delayMs: z.number().int().min(0).max(1000).optional(),
  }),
  z.object({ action: z.literal('click'), target: z.string() }),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(5000) }),
]);
export type Step = z.infer<typeof StepSchema>;

/** Raw shape, as registerAppTool takes it. */
export const InspectRenderInputShape = {
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(30),
  /** File that exports the component to mount. */
  entry: z.string(),
  exportName: z.string().default('default'),
  /** JSON props for that component. */
  props: z.record(z.string(), z.unknown()).optional(),
  /** The interaction; targets are CSS selectors. */
  steps: z.array(StepSchema).min(1).max(20),
  /** Compare with an earlier run (the run id from an earlier result, `r_` plus 4–6 characters). */
  baselineRunId: z.string().optional(),
};
export const InspectRenderInputSchema = z.object(InspectRenderInputShape);
export type InspectRenderInput = z.infer<typeof InspectRenderInputSchema>;

// ---------------------------------------------------------------------------
// Raw trace: what the page instrumentation records in one run (window.__RT__)
// ---------------------------------------------------------------------------

/**
 * What caused a commit. `follow-up` and `later` come from the spike's 20 ms gap heuristic and are
 * approximate (flaky on Windows). The analyzer doesn't read them: it groups steps from `inputSeq`
 * and state changes (src/analyzer/steps.ts).
 */
export type CommitTrigger = 'mount' | 'input' | 'follow-up' | 'later';

export interface ChangedProp {
  name: string;
  /** True when only the reference changed: a new object, array or function with the same contents. */
  sameValue: boolean;
  type: string;
}

export interface ChangedState {
  /** Index in the component's hook list (useContext adds no hook). */
  hook: number;
  from: string;
  to: string;
}

export interface ChangedContext {
  /** The context's displayName, or "Context". */
  name: string;
  sameValue: boolean;
  from: string;
  to: string;
}

export interface RenderedComponent {
  name: string;
  phase: 'mount' | 'update';
  memo: boolean;
  /** Nearest composite parent fiber (not the owner that created the element). */
  parent: string | null;
  selfMs: number;
  /** actualDuration: this component plus everything below it that rendered in this commit. */
  totalMs: number;
  changedProps: ChangedProp[];
  changedState: ChangedState[];
  changedContext: ChangedContext[];
}

export interface RecordedCommit {
  index: number;
  /** performance.now() when React reported the commit, unrounded (about 0.1 ms resolution). */
  at: number;
  /** performance.now() after the commit was recorded, unrounded. The next gap is measured from here. */
  doneAt: number;
  /** Number of user input events (input, click) seen before this commit. */
  inputSeq: number;
  trigger: CommitTrigger;
  /** Sum of the topmost rendered components' actualDuration. */
  renderMs: number;
  rendered: RenderedComponent[];
}

export interface RecordedTrace {
  commits: RecordedCommit[];
  /** Errors thrown inside the instrumentation itself. */
  errors: string[];
  /** True when commits beyond the cap (500) were dropped. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Trace summary over the repeated runs (structuredContent.run)
// ---------------------------------------------------------------------------

export interface ComponentGroup {
  name: string;
  count: number;
  memo: boolean;
  /** Why it rendered, in short text: changed props, state and context. */
  notes: string[];
}

export interface CommitSummary {
  index: number;
  trigger: CommitTrigger;
  /** Median over the runs that recorded this commit. */
  renderMs: number;
  renderMsRuns: number[];
  rendered: ComponentGroup[];
}

export interface TraceSummary {
  entry: string;
  exportName: string;
  reactVersion: string;
  browser: string;
  steps: Step[];
  runs: number;
  /** False when render counts differed between runs. */
  stable: boolean;
  instability: string[];
  commitCount: number;
  /** True when any run hit the commit cap and later commits were dropped. */
  truncated: boolean;
  /** Structure from the first run, timings as medians over all runs. */
  commits: CommitSummary[];
  /** Renders per component after the mount commit; components seen at mount that never re-rendered are 0. */
  rendersAfterMount: Record<string, number>;
  timings: {
    mountMs: number;
    inputCommits: number;
    /** Median of the input commits' (per-commit median) render times. */
    inputMedianMs: number;
    followUpCommits: number;
    laterCommits: number;
    frameBudgetMs: number;
  };
  /** Imports that weren't in `files` and were replaced with a harmless stub. */
  stubs: string[];
  timerResolutionMs: number;
  /** Uncaught errors and console errors from the page, and instrumentation errors. */
  pageErrors: string[];
}

export type RecordErrorKind = 'input' | 'bundle' | 'browser' | 'mount' | 'step' | 'timeout' | 'internal';

export interface RecordError {
  kind: RecordErrorKind;
  message: string;
  details: string[];
  stubs: string[];
}

// ---------------------------------------------------------------------------
// Analysis: steps, findings, the keystroke view and the comparison (HANDOFF.md §7, §8)
// ---------------------------------------------------------------------------

/**
 * One step of the interaction: an input commit plus the follow-up commits it caused (a follow-up
 * is a commit with no input since the previous one, in which a component that rendered in the
 * previous commit changed its own state). For typing, one step is one letter.
 */
export interface InteractionStep {
  index: number;
  /** Commit indices: the input commit first, then its follow-ups. */
  commits: number[];
  /** Sum of the step's commits' render times (each the median over the runs). */
  renderMs: number;
  /** Component renders in the step, all commits together. */
  renders: number;
}

export type FindingRule = 'unstable-prop' | 'state-in-effect';

export type FixKind = 'useMemo' | 'useCallback' | 'stabilize-deps' | 'compute-in-render';

export interface SourceLocation {
  /** Path as sent in `files`. */
  file: string;
  /** 1-based. */
  line: number;
  /** The source at that spot, whitespace collapsed (for example `filters={{ sort: 'recent', tags }}`). */
  snippet: string;
}

export interface Finding {
  /** Stable across runs, used by the comparison: `unstable-prop:ResultsList:filters`. */
  id: string;
  rule: FindingRule;
  /** 1 = the headline. */
  rank: number;
  /** The component that re-rendered (rule 1) or set state (rule 2). */
  component: string;
  /** Rule 1: the unstable prop. */
  prop?: { name: string; type: string };
  /** Rule 2: the state hook that was set, and the function (component or custom hook) that declares it. */
  hook?: { index: number; state: string | null; setter: string; owner: string };
  location: SourceLocation | null;
  /** Steps it happened on, out of all steps. */
  stepsAffected: number;
  steps: number;
  /** Commit indices it happened in (first run). */
  commits: number[];
  /**
   * Median over all steps (a step without it counts as 0). Rule 1: wasted ms (the memo component
   * and everything below it). Rule 2: render ms of the extra updates.
   */
  msPerStep: number;
  /** Median over all steps. Rule 1: wasted renders. Rule 2: renders in the extra updates. */
  rendersPerStep: number;
  /** Rule 2: extra updates per step (mean over all steps). */
  extraUpdatesPerStep?: number;
  /** Rule 1: the components below the memo component that re-rendered with it, per step: `{ ResultRow: 200 }`. */
  below?: Record<string, number>;
  fix: { kind: FixKind; compilerFixes: boolean };
  /** Plain-language texts for the card and the text result. */
  texts: {
    /** One line for the numbered list in the text result. */
    summary: string;
    why: string;
    line: string;
    fix: string;
  };
}

export type TreeLabel = 'state-origin' | 'needed' | 'memo-broken' | 'nothing-changed' | 'skipped';

/** Card copy for the tree labels (HANDOFF.md §8). */
export const TREE_LABEL_TEXT: Record<TreeLabel, string> = {
  'state-origin': 'Your state changed here',
  needed: 'Re-rendered · needed',
  'memo-broken': "Re-rendered · memo couldn't skip it",
  'nothing-changed': 'Re-rendered · nothing changed',
  skipped: 'Skipped · memo worked',
};

export interface TreeRow {
  name: string;
  /** Depth in the component tree of the step's input update (0 = top). */
  depth: number;
  label: TreeLabel;
  memo: boolean;
  /** Instances with the same name and label at this depth (for example 200 list rows). */
  count: number;
  /** Components below it that re-rendered with it (only for memo-broken rows): `{ ResultRow: 200 }`. */
  below: Record<string, number>;
  /** This component plus everything below it, ms (0 for skipped rows). */
  ms: number;
}

/** What one typical step costs: the card's headline, time bar and tree. */
export interface KeystrokeView {
  /** What one step is, in words: letter, click or step. */
  unit: 'letter' | 'click' | 'step';
  /** "Typing \"hello\" (5 letters)" */
  label: string;
  /** Caption: "Rendertrail · typed “hello” into SearchPage" without the product name. */
  caption: string;
  steps: number;
  /** Median over the steps. */
  msPerStep: number;
  rendersPerStep: number;
  frameBudgetMs: number;
  overBudget: boolean;
  /** Time bar: wasted (the top rule 1 finding's waste) vs everything else, per step. */
  wastedMsPerStep: number;
  restMsPerStep: number;
  headline: string;
  subline: string;
  /** At most 5 rows, in tree order, for the step whose cost is the median. */
  tree: TreeRow[];
}

export interface FindingRef {
  id: string;
  rule: FindingRule;
  component: string;
  summary: string;
}

export interface Comparison {
  baselineRunId: string;
  /** False when no stored run has that id; then only `message` is meaningful. */
  found: boolean;
  message: string;
  before?: { msPerStep: number; rendersPerStep: number; steps: number };
  after?: { msPerStep: number; rendersPerStep: number; steps: number };
  resolved: FindingRef[];
  stillThere: FindingRef[];
  new: FindingRef[];
  /** False when the interaction (entry, export, props or steps) differs from the baseline's. */
  sameInteraction: boolean;
  /** Files added, removed or changed since the baseline (paths as sent). */
  changedFiles: string[];
}

export interface RunInfo {
  /** `r_` plus 6 characters. */
  id: string;
  createdAt: string;
  summary: TraceSummary;
  steps: InteractionStep[];
}

/** structuredContent of inspect_render. */
export type InspectRenderOutput =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      run: RunInfo;
      /** Ranked, at most 3 (the card shows at most 3). */
      findings: Finding[];
      keystroke: KeystrokeView;
      comparison?: Comparison;
    }
  | { schemaVersion: typeof SCHEMA_VERSION; error: RecordError };

/** One run on disk (`<runs dir>/<id>.json`). */
export interface StoredRun {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  createdAt: string;
  input: {
    files: { path: string; content: string }[];
    entry: string;
    exportName: string;
    props?: Record<string, unknown>;
    steps: Step[];
  };
  summary: TraceSummary;
  steps: InteractionStep[];
  findings: Finding[];
  keystroke: KeystrokeView;
}
