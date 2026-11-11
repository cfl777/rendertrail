/**
 * Pure: plain words for numbers and for one step of the interaction (letter, click or step).
 */
import type { KeystrokeView, Step } from '../shared/types.js';

export interface UnitWords {
  unit: KeystrokeView['unit'];
  /** "letter" */
  one: string;
  /** "letters" */
  many: string;
  /** "Every letter you type" */
  every: string;
  /** "Each keystroke" */
  each: string;
}

const WORDS: Record<KeystrokeView['unit'], UnitWords> = {
  letter: { unit: 'letter', one: 'letter', many: 'letters', every: 'Every letter you type', each: 'Each keystroke' },
  click: { unit: 'click', one: 'click', many: 'clicks', every: 'Every click', each: 'Each click' },
  step: { unit: 'step', one: 'step', many: 'steps', every: 'Every step of the interaction', each: 'Each step' },
};

/**
 * What one step is. Typing only: a letter, when every letter made exactly one step. Clicking only:
 * a click, likewise. Anything else: a step.
 */
export function unitFor(steps: readonly Step[], stepCount: number): UnitWords {
  const acting = steps.filter((s) => s.action !== 'wait');
  const letters = acting.reduce((sum, s) => sum + (s.action === 'type' ? [...s.text].length : 0), 0);
  if (acting.length > 0 && acting.every((s) => s.action === 'type') && letters === stepCount) return WORDS.letter;
  if (acting.length > 0 && acting.every((s) => s.action === 'click') && acting.length === stepCount) return WORDS.click;
  return WORDS.step;
}

/** "20.6 ms", "0.1 ms", "under 0.1 ms" (the timer resolution is about 0.1 ms). */
export function msText(ms: number): string {
  if (ms < 0.05) return 'under 0.1 ms';
  return `${Math.round(ms * 10) / 10} ms`;
}

/** The mounted component's name as people would say it: the export, or the entry file's name. */
export function componentLabel(entry: string, exportName: string): string {
  if (exportName !== 'default') return exportName;
  const base = entry.split(/[\/]/).pop() ?? entry;
  return base.replace(/\.[^.]+$/, '');
}

function quote(text: string): string {
  return `“${text}”`;
}

/** What was done, in words for the card's caption, from the steps alone (also when no update followed). */
function captionFor(acting: readonly Step[], component: string): string {
  const typed = acting.flatMap((s) => (s.action === 'type' ? [s.text] : []));
  if (acting.length > 0 && typed.length === acting.length) return `typed ${typed.map(quote).join(', ')} into ${component}`;
  if (acting.length > 0 && acting.every((s) => s.action === 'click')) return `clicked ${acting.length} ${acting.length === 1 ? 'time' : 'times'} in ${component}`;
  return `played ${acting.length} ${acting.length === 1 ? 'action' : 'actions'} in ${component}`;
}

/** "Typing "hello" (5 letters)" for the text, and "typed “hello” into SearchPage" for the card's caption. */
export function interactionLabels(steps: readonly Step[], unit: UnitWords, stepCount: number, component: string): { label: string; caption: string } {
  const acting = steps.filter((s) => s.action !== 'wait');
  const typed = acting.flatMap((s) => (s.action === 'type' ? [s.text] : []));
  const caption = captionFor(acting, component);
  if (unit.unit === 'letter') {
    const texts = typed.map((t) => JSON.stringify(t)).join(', ');
    return { label: `Typing ${texts} (${stepCount} ${stepCount === 1 ? unit.one : unit.many})`, caption };
  }
  if (unit.unit === 'click') return { label: `Clicking ${stepCount} ${stepCount === 1 ? 'time' : 'times'}`, caption };
  return { label: `The interaction (${stepCount} ${stepCount === 1 ? 'step' : 'steps'} with input)`, caption };
}
