import { describe, expect, it } from 'vitest';
import { checkInput, recordRender } from './index.js';

const steps = [{ action: 'wait' as const, ms: 0 }];

describe('checkInput', () => {
  it('accepts a small input', () => {
    expect(checkInput({ files: [{ path: 'a.tsx', content: 'x' }], entry: 'a.tsx', exportName: 'default', steps })).toBeNull();
  });

  it('refuses more than 300 KB of source', () => {
    const files = [{ path: 'a.tsx', content: 'x'.repeat(301 * 1024) }];
    const error = checkInput({ files, entry: 'a.tsx', exportName: 'default', steps });
    expect(error?.kind).toBe('input');
    expect(error?.message).toContain('300 KB');
  });

  it('refuses the same file twice', () => {
    const files = [
      { path: 'a.tsx', content: '' },
      { path: './a.tsx', content: '' },
    ];
    expect(checkInput({ files, entry: 'a.tsx', exportName: 'default', steps })?.message).toContain('twice');
  });
});

describe('recordRender', () => {
  it('returns bundle errors as results, before starting a browser', async () => {
    const files = [{ path: 'a.tsx', content: 'export default (' }];
    const result = await recordRender({ files, entry: 'a.tsx', exportName: 'default', steps });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('bundle');
  });
});
