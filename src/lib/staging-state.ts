import { createDefaultState } from './default-state';
import { deterministicAnalysis } from './scoring';
import type { AppState, Job } from './types';

/** Fictional, local-only examples; no employer links, documents, or external identifiers. */
export function createStagingState(): AppState {
  const state = createDefaultState();
  const now = new Date().toISOString();
  state.notificationsEnabled = false;
  state.settings.fitThreshold = 0; // Show every synthetic example regardless of its calculated score.
  state.careerProfile = {
    generatedAt: now, candidateName: 'Synthetic Test Candidate', headline: 'Fictional program manager for staging tests',
    yearsExperience: 8, evidence: [{ id: 'synthetic-evidence', type: 'SKILL', label: 'Program management', detail: 'Fictional test experience; not a real person.', confidence: 1 }],
    skills: ['Program management', 'Project management', 'Stakeholder communication'], technologies: ['Jira'],
    certifications: [], education: [], domains: ['Software'], leadershipSignals: ['Team leadership'], accomplishments: ['Synthetic example only'], sourceFileIds: [],
  };
  state.jobs = ['Program Manager', 'Project Manager'].map((title, index): Job => ({
    id: `staging-example-${index + 1}`, title: `[TEST] ${title}`, company: 'Fictional Example Company',
    applicationUrl: '/guide', sourceUrl: '/guide', description: 'Synthetic staging fixture. Review program delivery, stakeholder communication and project planning. This is not a real vacancy; there is no employer submission endpoint.',
    location: 'Remote', country: 'US', workArrangement: 'REMOTE', employmentType: 'FULL_TIME', salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD',
    datePosted: now, dateDiscovered: now, lastVerifiedDate: now, source: 'SYNTHETIC STAGING FIXTURE', searchLane: 'PROGRAM_PROJECT',
    verificationStatus: 'ACTIVE_LIKELY', repost: false, duplicateFingerprint: `staging-fixture-${index + 1}`, active: true,
  }));
  state.analyses = state.jobs.map(job => deterministicAnalysis(job, state.careerProfile!));
  state.applications = [{ id: 'staging-tracking-example', jobId: state.jobs[0].id, status: 'REVIEWING', interviewDates: [], notes: ['Synthetic tracking record; no real application submitted.'], updatedAt: now }];
  return state;
}
