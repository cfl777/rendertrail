/**
 * The card harness data (ui/dev/results/*.json) must match what the analyzer makes from the saved
 * traces today. If this fails after an analyzer change, run `npm run card:results` and look at the
 * card again (`npm run dev:card`).
 */
import { describe, expect, it } from 'vitest';
import { buildCardResults, readCardResult, serialize } from './helpers/card-results.js';

describe('card harness results', () => {
  it('are up to date with the analyzer', async () => {
    const results = await buildCardResults();
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(9);
    for (const [name, result] of Object.entries(results)) {
      expect(await readCardResult(name), `ui/dev/results/${name}.json is stale: run npm run card:results`).toBe(serialize(result));
    }
  });
});
