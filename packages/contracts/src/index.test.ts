import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './index.js';

describe('health wire contract', () => {
  it('accepts the healthy status and rejects unrecognized data', () => {
    expect(HealthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(HealthResponseSchema.safeParse({ status: 'ok', token: 'unexpected' }).success).toBe(false);
  });
});
