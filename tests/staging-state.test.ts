import { describe, expect, it } from 'vitest';
import { createStagingState } from '@/lib/staging-state';
import { createDefaultState } from '@/lib/default-state';
describe('synthetic staging fixtures', () => {
  it('provides job review and tracking content without external links or real identity', () => {
    const state = createStagingState();
    expect(state.jobs).toHaveLength(2);
    expect(state.analyses).toHaveLength(2);
    expect(state.applications).toHaveLength(1);
    expect(state.careerProfile?.candidateName).toBe('Synthetic Test Candidate');
    expect(state.careerProfile?.sourceFileIds).toEqual([]);
    expect(state.notificationsEnabled).toBe(false);
    for (const job of state.jobs) {
      expect(job.title).toMatch(/^\[TEST\]/);
      expect(job.applicationUrl).toBe('/guide');
      expect(job.sourceUrl).toBe('/guide');
    }
    expect(state.applicationPackages).toEqual([]);
  });
  it('does not seed production defaults', () => {
    expect(createDefaultState().jobs).toEqual([]);
    expect(createDefaultState().careerProfile).toBeUndefined();
  });
  it('returns independent state for each initialization', () => {
    const first = createStagingState();
    first.jobs.length = 0;
    expect(createStagingState().jobs).toHaveLength(2);
  });
});
