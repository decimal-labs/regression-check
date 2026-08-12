import { describe, it, expect } from 'vitest';
import { shouldFail } from '../src/index';

describe('shouldFail', () => {
  it('high verdict + high threshold → fails', () => {
    expect(shouldFail('high_risk', 'high')).toBe(true);
  });

  it('high verdict + medium threshold → fails', () => {
    expect(shouldFail('high_risk', 'medium')).toBe(true);
  });

  it('high verdict + none threshold → does not fail', () => {
    expect(shouldFail('high_risk', 'none')).toBe(false);
  });

  it('medium verdict + high threshold → does not fail', () => {
    expect(shouldFail('medium_risk', 'high')).toBe(false);
  });

  it('medium verdict + medium threshold → fails', () => {
    expect(shouldFail('medium_risk', 'medium')).toBe(true);
  });

  it('low verdict never fails at default thresholds', () => {
    expect(shouldFail('low_risk', 'high')).toBe(false);
    expect(shouldFail('low_risk', 'medium')).toBe(false);
  });

  it('no_change never fails', () => {
    expect(shouldFail('no_change', 'high')).toBe(false);
    expect(shouldFail('no_change', 'medium')).toBe(false);
    expect(shouldFail('no_change', 'none')).toBe(false);
  });

  it('first_run never fails', () => {
    expect(shouldFail('first_run', 'high')).toBe(false);
    expect(shouldFail('first_run', 'medium')).toBe(false);
  });
});
