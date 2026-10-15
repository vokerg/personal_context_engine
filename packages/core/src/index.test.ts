import { describe, expect, it } from 'vitest';
import { assertNever } from './index.js';

describe('assertNever', () => {
  it('fails closed for unexpected runtime variants', () => {
    expect(() => assertNever('unknown' as never)).toThrow('Unexpected domain variant: unknown');
  });
});
