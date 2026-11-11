/**
 * Pure helpers for the card: reading what the host sends, and the few texts the card puts
 * together from structuredContent's numbers (never from the text result).
 */
import { BRAND } from '../../src/brand';
import { msText, unitFor } from '../../src/analyzer/words';
import { SCHEMA_VERSION } from '../../src/shared/constants';
import type { Comparison, Finding, InspectRenderOutput, KeystrokeView, RecordErrorKind } from '../../src/shared/types';

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

/** A tool call that ended without a result the card can draw: an error result or a cancel. */
export interface Problem {
  kind: 'failed' | 'cancelled';
  /** The result's text, or the cancel reason; empty when there is none. */
  text: string;
}

/** What the card shows: nothing yet, the arguments (receiving), the result, or a problem. */
export interface CardState {
  input: ToolInput | null;
  /** True once the complete arguments arrived: the recording is running. */
  recording: boolean;
  output: Output | null;
  problem: Problem | null;
}

export const EMPTY_STATE: CardState = { input: null, recording: false, output: null, problem: null };

/** What the card can ask the host to do. */
export interface HostActions {
  /** Put a message in the chat (Claude: the message box). False when the host refused. */
  sendMessage(text: string): Promise<boolean>;
  copyText(text: string): Promise<boolean>;
  /** Tell Claude what the user opened, without sending a message (one short item, e.g. "Why does it happen?"). */
  noteOpened(item: string): void;
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

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((c) => (isObject(c) && c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
    .join('\n')
    .trim();
}

/**
 * A tool result: our structuredContent when it is there; otherwise (an error result, or a result
 * without structuredContent) a problem with the result's text, so the card never waits forever.
 */
export function applyToolResult(s: CardState, result: { isError?: boolean; structuredContent?: unknown; content?: unknown }): CardState {
  const output = result.isError ? null : parseOutput(result.structuredContent);
  if (output) return { ...s, output, problem: null };
  return { ...s, output: null, problem: { kind: 'failed', text: resultText(result.content) } };
}

export function applyCancelled(s: CardState, reason?: string): CardState {
  if (s.output) return s;
  return { ...s, problem: { kind: 'cancelled', text: reason ?? '' } };
}

/**
 * updateModelContext replaces what it sent before, so every call sends everything the user has
 * opened so far. Returns the function the card calls with each item.
 */
export function openedTracker(send: (text: string) => void): (item: string) => void {
  const opened: string[] = [];
  return (item) => {
    if (opened.includes(item)) return;
    opened.push(item);
    send(`In the ${BRAND.displayName} card, the user opened: ${opened.join('; ')}.`);
  };
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

/** Milliseconds in whole tenths, the precision the card shows (and about the timer's resolution). */
function tenths(ms: number): number {
  return Math.round(ms * 10);
}

export type ComparisonVerdict = 'fixed' | 'partly' | 'faster' | 'not-fixed' | 'unchecked';

/**
 * - fixed: the baseline's top finding is resolved, nothing is new, and a step fits a screen refresh.
 * - partly: something was resolved, but not all of that (a finding left, a new one, or still slow).
 * - faster: nothing was resolved, but a step got clearly faster (at least 10 % and 0.5 ms).
 * - not-fixed: anything else.
 * Times are compared in tenths of a millisecond, as shown, so float noise can't tip the verdict.
 */
export function comparisonVerdict(c: Comparison, frameBudgetMs: number): ComparisonVerdict {
  if (!c.checked || !c.before || !c.after) return 'unchecked';
  const before = tenths(c.before.msPerStep);
  const after = tenths(c.after.msPerStep);
  const topResolved = c.baselineTopFindingId !== undefined && c.resolved.some((r) => r.id === c.baselineTopFindingId);
  if (topResolved && c.new.length === 0 && after <= tenths(frameBudgetMs)) return 'fixed';
  if (c.resolved.length > 0) return 'partly';
  if (before - after >= Math.max(before / 10, 5)) return 'faster';
  return 'not-fixed';
}

export function comparisonHeadline(c: Comparison, output: ResultOutput): string {
  const k = output.keystroke;
  const verdict = comparisonVerdict(c, k.frameBudgetMs);
  if (verdict === 'unchecked' || !c.before || !c.after) return "Couldn't check the fix.";
  const each = unitFor(output.run.summary.steps, k.steps).each;
  const after = msText(c.after.msPerStep);
  const before = msText(c.before.msPerStep);
  switch (verdict) {
    case 'fixed':
      return `Fixed. ${each} now takes ${after}.`;
    case 'partly':
      return `Partly fixed. ${each} now takes ${after} (it took ${before}).`;
    case 'faster':
      return `Faster. ${each} now takes ${after}, down from ${before}.`;
    case 'not-fixed':
      return `Not fixed yet. ${each} takes ${after} (it took ${before}).`;
  }
}

/** The subline without its first sentence ("Each keystroke takes X ms."), when the headline already gives the time. */
export function budgetSentence(subline: string): string {
  const rest = subline.replace(/^.*? ms\. /, '');
  return rest === subline ? subline : rest;
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

/**
 * The ms shown on a tree row. Only rows that re-rendered for nothing behind memo get one, and the
 * top finding's row shows the wasted time from the time bar, so the card's numbers agree.
 */
export function treeRowMs(row: KeystrokeView['tree'][number], k: KeystrokeView, top: Finding | undefined): number | null {
  if (row.label !== 'memo-broken') return null;
  if (top?.rule === 'unstable-prop' && top.component === row.name && k.wastedMsPerStep > 0) return k.wastedMsPerStep;
  return row.ms >= 0.05 ? row.ms : null;
}

/** `text with `code` spans` → parts, for rendering the analyzer's texts. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  return text.split('`').map((part, i) => ({ code: i % 2 === 1, text: part })).filter((p) => p.text.length > 0);
}
