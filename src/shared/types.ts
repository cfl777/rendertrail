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
  /** Compare with an earlier run. Accepted, but unused until the run store lands (Phase 2). */
  baselineRunId: z.string().optional(),
};
export const InspectRenderInputSchema = z.object(InspectRenderInputShape);
export type InspectRenderInput = z.infer<typeof InspectRenderInputSchema>;

// ---------------------------------------------------------------------------
// Raw trace: what the page instrumentation records in one run (window.__RT__)
// ---------------------------------------------------------------------------

/**
 * What caused a commit. `follow-up` and `later` come from the spike's 20 ms gap heuristic and are
 * approximate (flaky on Windows); Phase 2 replaces them using `at`, `doneAt` and `inputSeq`.
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

/** structuredContent of inspect_render. Phase 2 adds findings, keystroke and comparison. */
export type InspectRenderOutput =
  | { schemaVersion: typeof SCHEMA_VERSION; run: TraceSummary }
  | { schemaVersion: typeof SCHEMA_VERSION; error: RecordError };
