import { describe, expect, it } from 'vitest';
import type { Step } from '../shared/types.js';
import { interactionLabels, unitFor } from './words.js';

const typing: Step[] = [
  { action: 'type', target: 'input', text: 'hello' },
  { action: 'wait', ms: 600 },
];

describe('interactionLabels', () => {
  it('says what was typed in the caption, also when no update followed (0 steps)', () => {
    expect(interactionLabels(typing, unitFor(typing, 5), 5, 'SearchPage').caption).toBe('typed “hello” into SearchPage');
    const none = interactionLabels(typing, unitFor(typing, 0), 0, 'SearchPage');
    expect(none.caption).toBe('typed “hello” into SearchPage');
    expect(none.label).toBe('The interaction (0 steps with input)');
  });

  it('says clicked for clicks and played for a mix', () => {
    const clicks: Step[] = [
      { action: 'click', target: 'a' },
      { action: 'click', target: 'b' },
    ];
    expect(interactionLabels(clicks, unitFor(clicks, 0), 0, 'Menu').caption).toBe('clicked 2 times in Menu');
    const mixed: Step[] = [...clicks, { action: 'type', target: 'i', text: 'x' }];
    expect(interactionLabels(mixed, unitFor(mixed, 3), 3, 'Form').caption).toBe('played 3 actions in Form');
  });
});
