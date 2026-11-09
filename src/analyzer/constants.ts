/**
 * Analyzer thresholds and ranking (HANDOFF.md §7). One place, so they can be tuned on real traces.
 */
import { FRAME_BUDGET_MS } from '../recorder/limits.js';

export const ANALYZER = {
  /** Rule 1 counts when it wastes at least this much per step (median over all steps). */
  unstablePropMinMsPerStep: 1,
  /** Rule 2 counts when it happens on at least this share of the steps. */
  stateInEffectMinStepShare: 0.5,
  /** Findings returned and shown (the card shows at most 3). */
  maxFindings: 3,
  /** One frame at 60 Hz (16.7 ms). */
  frameBudgetMs: FRAME_BUDGET_MS,
  /** Rows in the card's "What one keystroke does" tree. */
  maxTreeRows: 5,
} as const;

/** Findings are ranked by cost per step (ms), highest first; on a tie, rule 1 before rule 2. */
export const RULE_ORDER = ['unstable-prop', 'state-in-effect'] as const;
