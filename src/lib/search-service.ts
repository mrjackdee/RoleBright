import { assertExternalActionsAllowed } from './staging-safety';
import 'server-only';
import { nanoid } from 'nanoid';
import { discoverAll, verifyListing } from './job-sources';
import { deterministicAnalysis, passesHardFilters } from './scoring';
import { interpretAnalysis } from './ai';
import { getState, updateState } from './storage/state';
import type { Analysis, Job, SearchRun } from './types';
import { daysOld, fingerprint, normalizeText } from './utils';
import { notifySearchSummary } from './notifications';
import { logAppIssue } from './issues';

function semanticKey(job: Job) {
  return `${normalizeText(job.company)}|${normalizeText(job.title)}|${normalizeText(job.location)}`;
}

function chooseCanonical(a: Job, b: Job): Job {
  const employerish = (j: Job) => /workday|greenhouse|lever|careers|jobs\./i.test(j.applicationUrl) ? 2 : /serpapi/i.test(j.source) ? 1 : 0;
  return employerish(b) > employerish(a) ? b : a;
}

export async function runSearch(trigger: SearchRun['trigger']): Promise<SearchRun> {
  assertExternalActionsAllowed();
  const run: SearchRun = { id: nanoid(), startedAt: new Date().toISOString(), trigger, discovered: 0, qualified: 0, excluded: 0, inactive: 0, duplicates: 0, errors: [] };
  const { jobs: discovered, errors } = await discoverAll();
  run.errors.push(...errors);
  run.discovered = discovered.length;

  const state = await getState();
  const existingByFingerprint = new Map(state.jobs.map(j => [j.duplicateFingerprint, j]));
  const existingBySemantic = new Map(state.jobs.map(j => [semanticKey(j), j]));
  const candidateMap = new Map<string, Job>();

  for (const raw of discovered) {
    if (daysOld(raw.datePosted) > state.settings.lookbackDays && raw.datePosted) { run.excluded++; continue; }
    const job = { ...raw, duplicateFingerprint: raw.duplicateFingerprint || fingerprint([raw.company, raw.title, raw.location, raw.externalId]) };
    const existing = existingByFingerprint.get(job.duplicateFingerprint);
    if (existing) { run.duplicates++; continue; }
    const semanticExisting = existingBySemantic.get(semanticKey(job));
    if (semanticExisting && semanticExisting.active) { run.duplicates++; continue; }
    if (semanticExisting && !semanticExisting.active && semanticExisting.externalId !== job.externalId) job.repost = true;
    const key = semanticKey(job);
    const current = candidateMap.get(key);
    if (current) { candidateMap.set(key, chooseCanonical(current, job)); run.duplicates++; }
    else candidateMap.set(key, job);
  }

  const hardFiltered: Job[] = [];
  for (const job of candidateMap.values()) {
    const hard = passesHardFilters(job, state.settings.salaryFloor, state.settings.radiusMiles);
    const nonActiveReasons = hard.reasons.filter(r => r !== 'Listing is inactive');
    if (nonActiveReasons.length) { run.excluded++; continue; }
    hardFiltered.push(job);
  }

  const verified: Job[] = [];
  const batchSize = 6;
  for (let i = 0; i < hardFiltered.length; i += batchSize) {
    const batch = await Promise.all(hardFiltered.slice(i, i + batchSize).map(verifyListing));
    for (const job of batch) {
      if (job.verificationStatus === 'INACTIVE') { run.inactive++; continue; }
      verified.push(job);
    }
  }

  const analyses: Analysis[] = [];
  if (state.careerProfile) {
    for (const job of verified) {
      let analysis = deterministicAnalysis(job, state.careerProfile);
      if (analysis.overallFitScore >= state.settings.fitThreshold) {
        try { analysis = await interpretAnalysis(job, state.careerProfile, analysis); }
        catch (error) { run.errors.push(`AI review ${job.company}/${job.title}: ${error instanceof Error ? error.message : 'failed'}`); }
        analyses.push(analysis);
        run.qualified++;
      } else {
        run.excluded++;
      }
    }
  } else {
    run.errors.push('Career Profile is not ready; jobs were found but could not be ranked yet.');
  }

  run.completedAt = new Date().toISOString();
  await updateState(current => {
    current.jobs.push(...verified);
    current.analyses.push(...analyses);
    current.searchRuns.unshift(run);
    current.searchRuns = current.searchRuns.slice(0, 100);
  });

  if (run.errors.length) {
    await logAppIssue({
      area: trigger === 'MANUAL' ? 'Job search' : 'Scheduled search',
      action: trigger === 'MANUAL' ? 'Search for matching jobs' : 'Run an automatic job search',
      severity: 'WARNING',
      userMessage: 'The search finished, but part of the process needed attention. Some job sources or review steps may have been skipped.',
      technicalMessage: run.errors.join('\n'),
      route: trigger === 'MANUAL' ? '/api/search' : '/api/cron/search',
      resolved: false,
    });
  }

  if (state.notificationsEnabled !== false) {
    try {
      const qualifiedJobs = verified.filter(j => analyses.some(a => a.jobId === j.id)).sort((a,b) => (analyses.find(x=>x.jobId===b.id)?.overallFitScore ?? 0) - (analyses.find(x=>x.jobId===a.id)?.overallFitScore ?? 0));
      await notifySearchSummary(run, qualifiedJobs);
    } catch (error) {
      console.warn('Search notification failed', error instanceof Error ? error.message : error);
      await logAppIssue({ area:'Email updates', action:'Send the job-search summary email', severity:'WARNING', userMessage:'The job search finished, but the summary email could not be sent.', technicalMessage:error instanceof Error ? error.stack ?? error.message : String(error), route: trigger === 'MANUAL' ? '/api/search' : '/api/cron/search', resolved:false });
    }
  }
  return run;
}
