import { assertExternalActionsAllowed } from '../staging-safety';
import * as cheerio from 'cheerio';
import { nanoid } from 'nanoid';
import type { Job, SearchLane, WorkArrangement } from '../types';
import { expiredSignals } from '../config';
import { fingerprint, normalizeText, parseSalary } from '../utils';

export interface DiscoveryContext {
  lane: SearchLane;
  query: string;
  location?: string;
}

export interface JobSource {
  name: string;
  discover(ctx: DiscoveryContext): Promise<Job[]>;
}

function stripHtml(html: string): string {
  const $ = cheerio.load(html || '');
  return $.text().replace(/\s+/g, ' ').trim();
}

function inferArrangement(location: string, description = ''): WorkArrangement {
  const t = `${location} ${description}`.toLowerCase();
  if (/hybrid/.test(t)) return 'HYBRID';
  if (/remote|work from home|distributed/.test(t)) return 'REMOTE';
  if (/onsite|on-site|in office|in-office/.test(t)) return 'ONSITE';
  return 'UNKNOWN';
}

function employmentType(value = '', description = ''): Job['employmentType'] {
  const t = `${value} ${description}`.toLowerCase();
  if (/contract|freelance/.test(t)) return 'CONTRACT';
  if (/part[- ]?time/.test(t)) return 'PART_TIME';
  if (/temporary|temp\b/.test(t)) return 'TEMPORARY';
  if (/intern/.test(t)) return 'INTERNSHIP';
  if (/full[- ]?time|permanent/.test(t)) return 'FULL_TIME';
  return 'UNKNOWN';
}

function makeJob(input: Partial<Job> & Pick<Job, 'title' | 'company' | 'applicationUrl' | 'description' | 'location' | 'source' | 'searchLane'>): Job {
  const arrangement = input.workArrangement ?? inferArrangement(input.location, input.description);
  const fp = input.duplicateFingerprint ?? fingerprint([input.company, input.title, input.location, input.externalId, input.applicationUrl]);
  return {
    ...input,
    id: input.id ?? nanoid(),
    title: input.title.trim(),
    company: input.company.trim(),
    applicationUrl: input.applicationUrl,
    sourceUrl: input.sourceUrl ?? input.applicationUrl,
    description: input.description,
    location: input.location || 'Remote',
    workArrangement: arrangement,
    employmentType: input.employmentType ?? employmentType('', input.description),
    dateDiscovered: input.dateDiscovered ?? new Date().toISOString(),
    source: input.source,
    searchLane: input.searchLane,
    verificationStatus: input.verificationStatus ?? 'ACTIVE_LIKELY',
    repost: input.repost ?? false,
    duplicateFingerprint: fp,
    active: input.active ?? true,
  };
}

export class RemotiveSource implements JobSource {
  name = 'Remotive';
  async discover(ctx: DiscoveryContext): Promise<Job[]> {
    const url = new URL('https://remotive.com/api/remote-jobs');
    if (ctx.query) url.searchParams.set('search', ctx.query);
    url.searchParams.set('limit', '100');
    const res = await fetch(url, { headers: { 'User-Agent': 'JackDeeJobSearch/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Remotive ${res.status}`);
    const data = await res.json() as { jobs?: Array<Record<string, unknown>> };
    return (data.jobs ?? []).map(j => {
      const description = stripHtml(String(j.description ?? ''));
      const salary = parseSalary(String(j.salary ?? ''));
      return makeJob({
        externalId: String(j.id ?? ''),
        title: String(j.title ?? ''),
        company: String(j.company_name ?? ''),
        companyLogo: String(j.company_logo ?? '') || undefined,
        applicationUrl: String(j.url ?? ''),
        description,
        location: String(j.candidate_required_location ?? 'Remote'),
        workArrangement: 'REMOTE',
        employmentType: employmentType(String(j.job_type ?? ''), description),
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: salary.min || salary.max ? 'USD' : undefined,
        datePosted: String(j.publication_date ?? '') || undefined,
        source: this.name,
        searchLane: ctx.lane,
      });
    }).filter(j => j.title && j.company && j.applicationUrl);
  }
}

export class JobicySource implements JobSource {
  name = 'Jobicy';
  async discover(ctx: DiscoveryContext): Promise<Job[]> {
    const url = new URL('https://jobicy.com/api/v2/remote-jobs');
    url.searchParams.set('count', '100');
    url.searchParams.set('geo', 'usa');
    if (ctx.query) url.searchParams.set('tag', ctx.query);
    const res = await fetch(url, { headers: { 'User-Agent': 'JackDeeJobSearch/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Jobicy ${res.status}`);
    const data = await res.json() as { jobs?: Array<Record<string, unknown>> };
    return (data.jobs ?? []).map(j => {
      const description = stripHtml(String(j.jobDescription ?? ''));
      return makeJob({
        externalId: String(j.id ?? ''),
        title: String(j.jobTitle ?? ''),
        company: String(j.companyName ?? ''),
        companyLogo: String(j.companyLogo ?? '') || undefined,
        applicationUrl: String(j.url ?? ''),
        description,
        location: String(j.jobGeo ?? 'Remote'),
        workArrangement: 'REMOTE',
        employmentType: employmentType(String(j.jobType ?? ''), description),
        salaryMin: typeof j.salaryMin === 'number' ? j.salaryMin : undefined,
        salaryMax: typeof j.salaryMax === 'number' ? j.salaryMax : undefined,
        salaryCurrency: String(j.salaryCurrency ?? '') || undefined,
        datePosted: String(j.pubDate ?? '') || undefined,
        source: this.name,
        searchLane: ctx.lane,
      });
    }).filter(j => j.title && j.company && j.applicationUrl);
  }
}

export class SerpApiGoogleJobsSource implements JobSource {
  name = 'Google Jobs via SerpApi';
  async discover(ctx: DiscoveryContext): Promise<Job[]> {
    const key = process.env.SERPAPI_KEY;
    if (!key) return [];
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine', 'google_jobs');
    url.searchParams.set('q', ctx.query);
    url.searchParams.set('api_key', key);
    if (ctx.location) url.searchParams.set('location', ctx.location);
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`SerpApi ${res.status}`);
    const data = await res.json() as { jobs_results?: Array<Record<string, unknown>> };
    return (data.jobs_results ?? []).map(j => {
      const extensions: string[] = Array.isArray(j.extensions) ? j.extensions : [];
      const description = String(j.description ?? '');
      const applyOptions: Array<{ link?: string }> = Array.isArray(j.apply_options) ? j.apply_options : [];
      const applyUrl = applyOptions.find(o => o.link)?.link || j.share_link || '';
      const salary = parseSalary(`${extensions.join(' ')} ${description}`);
      const posted = extensions.find(x => /ago|today|day|hour/i.test(x));
      return makeJob({
        externalId: String(j.job_id ?? ''),
        title: String(j.title ?? ''),
        company: String(j.company_name ?? ''),
        applicationUrl: String(applyUrl),
        sourceUrl: String(j.share_link ?? applyUrl),
        description,
        location: String(j.location ?? ctx.location ?? ''),
        workArrangement: inferArrangement(String(j.location ?? ''), `${extensions.join(' ')} ${description}`),
        employmentType: employmentType(extensions.join(' '), description),
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: salary.min || salary.max ? 'USD' : undefined,
        datePosted: relativePostedDate(posted),
        source: this.name,
        searchLane: ctx.lane,
      });
    }).filter(j => j.title && j.company && j.applicationUrl);
  }
}

function relativePostedDate(value?: string): string | undefined {
  if (!value) return undefined;
  const t = value.toLowerCase();
  if (t.includes('today') || t.includes('hour')) return new Date().toISOString();
  const days = Number(t.match(/(\d+)\s+day/)?.[1]);
  if (Number.isFinite(days)) return new Date(Date.now() - days * 86400000).toISOString();
  return undefined;
}

export async function verifyListing(job: Job): Promise<Job> {
  assertExternalActionsAllowed();
  if (!job.applicationUrl.startsWith('http')) return { ...job, active: false, verificationStatus: 'INACTIVE', lastVerifiedDate: new Date().toISOString() };
  try {
    const response = await fetch(job.applicationUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 JackDeeJobSearch/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    const checked = new Date().toISOString();
    if (response.status === 404 || response.status === 410) return { ...job, active: false, verificationStatus: 'INACTIVE', lastVerifiedDate: checked };
    if (!response.ok) return { ...job, verificationStatus: 'STATUS_UNCERTAIN', lastVerifiedDate: checked };
    const body = (await response.text()).slice(0, 250000).toLowerCase();
    const expired = expiredSignals.some(signal => body.includes(signal));
    if (expired) return { ...job, active: false, verificationStatus: 'INACTIVE', lastVerifiedDate: checked };
    const applySignal = /apply|application|submit your application|apply now/.test(body);
    return { ...job, active: true, verificationStatus: applySignal ? 'ACTIVE_VERIFIED' : 'ACTIVE_LIKELY', lastVerifiedDate: checked };
  } catch {
    return { ...job, verificationStatus: 'STATUS_UNCERTAIN', lastVerifiedDate: new Date().toISOString() };
  }
}

export function classifyLane(title: string, fallback: SearchLane): SearchLane {
  const n = normalizeText(title);
  if (/scrum|agile/.test(n)) return 'AGILE';
  if (/product owner/.test(n)) return 'PRODUCT';
  if (/director|principal|senior director|transformation/.test(n)) return 'EXECUTIVE';
  return fallback;
}

export function defaultSources(): JobSource[] {
  return [new RemotiveSource(), new JobicySource(), new SerpApiGoogleJobsSource()];
}

export async function discoverAll(): Promise<{ jobs: Job[]; errors: string[] }> {
  assertExternalActionsAllowed();
  const jobs: Job[] = [];
  const errors: string[] = [];

  const targetTitle = /\b(project manager|program manager|technical project|technical program|delivery manager|portfolio manager|scrum master|agile (?:lead|delivery|program)|product owner|director.*(?:program|project|pmo|transformation|portfolio|delivery)|pmo director|principal program|strategic program|implementation project)\b/i;

  // Public remote feeds are intentionally called once per run. Their APIs publish
  // freshness delays and fair-use guidance, so role filtering happens locally.
  for (const source of [new RemotiveSource(), new JobicySource()]) {
    try {
      const found = await source.discover({ lane: 'PROGRAM_PROJECT', query: '' });
      jobs.push(...found.filter(j => targetTitle.test(j.title)).map(j => ({ ...j, searchLane: classifyLane(j.title, 'PROGRAM_PROJECT') })));
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // SerpApi is the broad discovery adapter when configured. Keep the query set
  // intentionally compact while covering executive, project/program, Agile, and Product lanes.
  const serp = new SerpApiGoogleJobsSource();
  if (process.env.SERPAPI_KEY) {
    const contexts: DiscoveryContext[] = [
      { lane: 'EXECUTIVE', query: 'director program management', location: 'Atlanta, Georgia' },
      { lane: 'EXECUTIVE', query: 'director program management', location: 'Dallas, Texas' },
      { lane: 'EXECUTIVE', query: 'director program management remote', location: 'United States' },
      { lane: 'PROGRAM_PROJECT', query: 'senior program manager OR senior project manager', location: 'Atlanta, Georgia' },
      { lane: 'PROGRAM_PROJECT', query: 'senior program manager OR senior project manager', location: 'Dallas, Texas' },
      { lane: 'PROGRAM_PROJECT', query: 'program manager OR project manager remote', location: 'United States' },
      { lane: 'AGILE', query: 'scrum master OR agile delivery lead remote', location: 'United States' },
      { lane: 'PRODUCT', query: 'product owner OR senior product owner remote', location: 'United States' },
    ];
    for (let i = 0; i < contexts.length; i += 3) {
      await Promise.all(contexts.slice(i, i + 3).map(async ctx => {
        try {
          const found = await serp.discover(ctx);
          jobs.push(...found.filter(j => targetTitle.test(j.title)).map(j => ({ ...j, searchLane: classifyLane(j.title, ctx.lane) })));
        } catch (error) {
          errors.push(`${serp.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }));
    }
  }

  return { jobs, errors };
}
