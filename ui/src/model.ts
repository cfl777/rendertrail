/**
 * Pure helpers for the card: reading what the host sends, and the few texts the card puts
 * together from structuredContent's numbers (never from the text result).
 */
import { BRAND } from '../../src/brand';
import { msText, unitFor } from '../../src/analyzer/words';
import {
  SCHEMA_VERSION,
  type Comparison,
  type Finding,
  type InspectRenderOutput,
  type KeystrokeView,
  type RecordErrorKind,
} from '../../src/shared/types';

export { msText };

export type Output = InspectRenderOutput;
export type ResultOutput = Extract<InspectRenderOutput, { run: unknown }>;
export type ErrorOutput = Extract<InspectRenderOutput, { error: unknown }>;

export interface SourceFile {
  path: string;
  content: string;
}

/** What the card knows about the tool call's arguments (complete or still streaming). */
export interface ToolInput {
  files: SourceFile[];
  /** Paths only, while the arguments are still streaming in. */
  paths: string[];
  entry: string | null;
}

/** What the card shows: nothing yet, the arguments (receiving), or the result. */
export interface CardState {
  input: ToolInput | null;
  /** True once the complete arguments arrived: the recording is running. */
  recording: boolean;
  output: Output | null;
}

/** What the card can ask the host to do. */
export interface HostActions {
  /** Put a message in the chat (Claude: the message box). False when the host refused. */
  sendMessage(text: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  /** Tell Claude what the user opened, without sending a message. */
  noteOpened(text: string): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseOutput(value: unknown): Output | null {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) return null;
  if (isObject(value.error) && typeof value.error.message === 'string') return value as Output;
  if (isObject(value.run) && isObject(value.keystroke) && Array.isArray(value.findings)) return value as Output;
  return null;
}

/** The tool arguments as far as they go: partial input may lack contents or even paths. */
export function parseToolInput(args: unknown): ToolInput | null {
  if (!isObject(args)) return null;
  const files: SourceFile[] = [];
  const paths: string[] = [];
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (!isObject(f) || typeof f.path !== 'string') continue;
      paths.push(f.path);
      if (typeof f.content === 'string') files.push({ path: f.path, content: f.content });
    }
  }
  const entry = typeof args.entry === 'string' ? args.entry : null;
  if (paths.length === 0 && entry === null) return null;
  return { files, paths, entry };
}

export function isError(output: Output): output is ErrorOutput {
  return 'error' in output;
}

/** "What one keystroke does" and the other per-step words. */
export function stepWords(k: KeystrokeView): { noun: string; treeTitle: string; per: string } {
  if (k.unit === 'letter') return { noun: 'keystroke', treeTitle: 'What one keystroke does', per: 'per keystroke' };
  if (k.unit === 'click') return { noun: 'click', treeTitle: 'What one click does', per: 'per click' };
  return { noun: 'step', treeTitle: 'What one step does', per: 'per step' };
}

/** HANDOFF.md §8: the follow-up message for "Fix it and check". */
export function fixMessage(k: KeystrokeView): string {
  const same = k.unit === 'letter' ? 'typing' : k.unit === 'click' ? 'clicks' : 'interaction';
  return `Fix it and check it again with the same ${same}.`;
}

export const RETRY_MESSAGE = 'Fix the input and record it again.';

export function errorHeadline(kind: RecordErrorKind): string {
  switch (kind) {
    case 'input':
      return 'The files or steps need a change before they can be recorded.';
    case 'bundle':
      return "The code couldn't be built.";
    case 'browser':
      return "Chrome couldn't start.";
    case 'mount':
      return "The component didn't render.";
    case 'step':
      return "A step of the interaction didn't work.";
    case 'timeout':
      return 'The recording took too long.';
    case 'internal':
      return `Something went wrong inside ${BRAND.displayName}.`;
  }
}

/** A finding in a few words, for the "Also found" list. */
export function findingTitle(f: Finding): string {
  if (f.rule === 'unstable-prop') return `${f.component} re-renders for nothing (prop ${f.prop?.name ?? '?'})`;
  return `${f.component} sets state inside an effect`;
}

export function locationText(f: Finding): string | null {
  return f.location ? `${f.location.file}:${f.location.line}` : null;
}

/** Changes smaller than the timer resolution (about 0.1 ms) are noise. */
const NOISE_MS = 0.1;

export function comparisonHeadline(c: Comparison, output: ResultOutput): string {
  const k = output.keystroke;
  if (!c.checked || !c.before || !c.after) return "Couldn't check the fix.";
  const each = unitFor(output.run.summary.steps, k.steps).each;
  const before = c.before.msPerStep;
  const after = c.after.msPerStep;
  const faster = before - after >= NOISE_MS;
  if (faster && c.resolved.length > 0 && c.new.length === 0) return `Fixed. ${each} now takes ${msText(after)}.`;
  if (faster) return `Faster. ${each} now takes ${msText(after)}, down from ${msText(before)}.`;
  return `Not fixed yet. ${each} takes ${msText(after)} (it took ${msText(before)}).`;
}

function rounded(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** "Copy for PR": a short before/after summary to paste into a pull request (HANDOFF.md §9). */
export function prSummary(output: ResultOutput): string {
  const c = output.comparison;
  const k = output.keystroke;
  const s = output.run.summary;
  const { per } = stepWords(k);
  const lines = [`Render check (${BRAND.displayName}): ${k.caption}`];
  if (c?.checked && c.before && c.after) {
    lines.push(
      `Time ${per}: ${msText(c.before.msPerStep)} → ${msText(c.after.msPerStep)} (one screen refresh is ${k.frameBudgetMs} ms)`,
      `Renders ${per}: ${rounded(c.before.rendersPerStep)} → ${rounded(c.after.rendersPerStep)}`,
    );
    const list = (refs: Comparison['resolved']): string => refs.map((r) => r.summary).join('; ');
    if (c.resolved.length) lines.push(`Resolved: ${list(c.resolved)}`);
    if (c.stillThere.length) lines.push(`Still there: ${list(c.stillThere)}`);
    if (c.new.length) lines.push(`New: ${list(c.new)}`);
    if (!c.sameInteraction) lines.push('Note: the interaction differs from the baseline run.');
  } else {
    lines.push(`Time ${per}: ${msText(k.msPerStep)}, ${rounded(k.rendersPerStep)} renders (one screen refresh is ${k.frameBudgetMs} ms)`);
  }
  lines.push(`Recorded in headless ${s.browser} with React ${s.reactVersion}, median of ${s.runs} runs.`);
  return lines.join('\n');
}

export interface BarScale {
  /** Width of a value in % of the track. */
  pct(ms: number): number;
  budgetPct: number;
}

/** The track spans the largest value or the frame budget, plus room so the marker isn't at the edge. */
export function barScale(values: readonly number[], budgetMs: number): BarScale {
  const max = Math.max(budgetMs, ...values) * 1.15;
  const pct = (ms: number): number => Math.round((Math.max(0, ms) / max) * 1000) / 10;
  return { pct, budgetPct: pct(budgetMs) };
}

/** `text with `code` spans` → parts, for rendering the analyzer's texts. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  return text.split('`').map((part, i) => ({ code: i % 2 === 1, text: part })).filter((p) => p.text.length > 0);
}
