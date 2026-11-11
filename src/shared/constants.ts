/**
 * The values the card needs from the shared types, without zod, so the card bundle stays small.
 * src/shared/types.ts re-exports them; import from there everywhere except the card.
 */

export const SCHEMA_VERSION = 1;

export type TreeLabel = 'state-origin' | 'needed' | 'memo-broken' | 'nothing-changed' | 'skipped';

/** Card copy for the tree labels (HANDOFF.md §8). */
export const TREE_LABEL_TEXT: Record<TreeLabel, string> = {
  'state-origin': 'Your state changed here',
  needed: 'Re-rendered · needed',
  'memo-broken': "Re-rendered · memo couldn't skip it",
  'nothing-changed': 'Re-rendered · nothing changed',
  skipped: 'Skipped · memo worked',
};
