import { describe, it, expect } from 'vitest';
import { buildReportUrl } from '../src/api';

describe('buildReportUrl', () => {
  it('replaces api. with app. in standard prod URL', () => {
    expect(buildReportUrl('https://api.decimal.ai', 'support-agent', 'rc_123')).toBe(
      'https://app.decimal.ai/agents/support-agent/regression/rc_123',
    );
  });

  it('encodes agent names with special characters', () => {
    expect(buildReportUrl('https://api.decimal.ai', 'my agent/v2', 'rc_123')).toBe(
      'https://app.decimal.ai/agents/my%20agent%2Fv2/regression/rc_123',
    );
  });

  it('handles base URLs without api. prefix', () => {
    expect(buildReportUrl('http://localhost:8000', 'agent', 'rc_1')).toBe(
      'http://localhost:8000/agents/agent/regression/rc_1',
    );
  });

  it('strips trailing /api', () => {
    expect(buildReportUrl('https://api.decimal.ai/api', 'agent', 'rc_1')).toBe(
      'https://app.decimal.ai/agents/agent/regression/rc_1',
    );
  });
});
