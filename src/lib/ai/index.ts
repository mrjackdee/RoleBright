import { assertExternalActionsAllowed } from '../staging-safety';
import 'server-only';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { Analysis, CareerEvidenceProfile, CoverLetterContent, Job, TailoredResumeContent } from '../types';

const model = () => {
  assertExternalActionsAllowed();
  return process.env.AI_MODEL || 'openai/gpt-5.6-sol';
};
const gatewayOptions = { gateway: { zeroDataRetention: true, tags: ['app:jackdee-job-search'] } } as any;

const careerProfileSchema = z.object({
  candidateName: z.string(),
  headline: z.string(),
  yearsExperience: z.number().optional(),
  evidence: z.array(z.object({
    id: z.string(),
    type: z.enum(['EMPLOYMENT', 'SKILL', 'TECHNOLOGY', 'CERTIFICATION', 'EDUCATION', 'ACCOMPLISHMENT', 'DOMAIN']),
    label: z.string(),
    detail: z.string(),
    sourceFileId: z.string().optional(),
    sourceFileName: z.string().optional(),
    confidence: z.number().min(0).max(1),
  })),
  skills: z.array(z.string()),
  technologies: z.array(z.string()),
  certifications: z.array(z.string()),
  education: z.array(z.string()),
  domains: z.array(z.string()),
  leadershipSignals: z.array(z.string()),
  accomplishments: z.array(z.string()),
});

export async function buildCareerEvidenceProfile(sources: Array<{ id: string; name: string; text: string }>): Promise<CareerEvidenceProfile> {
  const sourceText = sources.map(s => `\n=== SOURCE FILE: ${s.name} [${s.id}] ===\n${s.text}`).join('\n').slice(0, 180000);
  const { object } = await generateObject({
    model: model(),
    schema: careerProfileSchema,
    providerOptions: gatewayOptions,
    prompt: `Create a strict Career Evidence Profile from the source documents below.

NON-NEGOTIABLE RULES:
- Treat the source documents as the only authority.
- Never invent or infer unproven employers, titles, dates, technologies, certifications, degrees, metrics, accomplishments, industries, responsibilities, or years of experience.
- If a fact is ambiguous, omit it or use low confidence.
- Preserve quantified accomplishments exactly in substance.
- Distinguish documented skills from adjacent or transferable skills.
- Evidence records must point to a source file by id and name whenever possible.

${sourceText}`,
  });
  return { ...object, generatedAt: new Date().toISOString(), sourceFileIds: sources.map(s => s.id) };
}

const interpretationSchema = z.object({
  strengths: z.array(z.string()).max(10),
  wordingGaps: z.array(z.string()).max(10),
  trueExperienceGaps: z.array(z.string()).max(10),
  hardQualificationRisks: z.array(z.string()).max(10),
  recruiterObjections: z.array(z.string()).max(10),
  strategy: z.string(),
});

export async function interpretAnalysis(job: Job, profile: CareerEvidenceProfile, analysis: Analysis): Promise<Analysis> {
  const { object } = await generateObject({
    model: model(),
    schema: interpretationSchema,
    providerOptions: gatewayOptions,
    prompt: `Evaluate the candidate evidence against the job without changing the deterministic numeric score.

RULES:
- Never fabricate experience.
- A wording gap means the evidence exists but could be positioned more explicitly.
- A true experience gap means the supplied evidence does not support the requirement.
- Do not convert a true gap into a wording gap.
- Identify overqualification/recruiter risks candidly.

JOB:\n${JSON.stringify({ title: job.title, company: job.company, description: job.description, location: job.location, salaryMin: job.salaryMin, salaryMax: job.salaryMax })}

CAREER PROFILE:\n${JSON.stringify(profile)}

DETERMINISTIC ANALYSIS:\n${JSON.stringify(analysis)}`,
  });
  return {
    ...analysis,
    strengths: object.strengths,
    wordingGaps: object.wordingGaps,
    trueExperienceGaps: object.trueExperienceGaps,
    hardQualificationRisks: object.hardQualificationRisks,
    recruiterObjections: object.recruiterObjections,
    gaps: [...object.trueExperienceGaps, ...object.hardQualificationRisks],
    recommendedApplicationStrategy: object.strategy,
  };
}

const resumeSchema = z.object({
  candidateName: z.string(),
  contactLine: z.string(),
  headline: z.string(),
  summary: z.string(),
  coreCompetencies: z.array(z.string()).min(6).max(24),
  sections: z.array(z.object({
    heading: z.string(),
    bullets: z.array(z.string()).optional(),
    paragraphs: z.array(z.string()).optional(),
  })),
  education: z.array(z.string()),
  certifications: z.array(z.string()),
  supportedKeywords: z.array(z.string()),
  excludedUnsupportedKeywords: z.array(z.string()),
  modifications: z.array(z.string()),
});

export async function tailorResume(args: {
  job: Job;
  profile: CareerEvidenceProfile;
  masterResumeText: string;
  analysis: Analysis;
}): Promise<TailoredResumeContent> {
  const { object } = await generateObject({
    model: model(),
    schema: resumeSchema,
    providerOptions: gatewayOptions,
    prompt: `Create an ATS-safe tailored resume for the target job from the approved master resume and Career Evidence Profile.

STRICT FACTUAL RULES:
- Never invent or materially embellish experience, employers, titles, dates, education, certifications, tools, metrics, industries, responsibilities, or accomplishments.
- Preserve actual historical employer names, titles, and dates exactly as shown in the source.
- Do not add a technology or keyword unless the Career Evidence Profile supports it.
- Do not create a sabbatical section.
- A true experience gap must remain a gap. Do not compensate with false language.
- You may reorder and rewrite supported bullets, summary, competencies, and emphasis.
- Keep the result approximately two pages when rendered in a normal 10.5–11pt professional font.
- Use single-column ATS-safe content.
- Avoid generic AI language.
- If overqualification risk is HIGH, emphasize hands-on execution, scope, schedule, risk, dependencies, implementation, collaboration, client delivery and vendor coordination while preserving actual titles.

TARGET JOB:\n${JSON.stringify(args.job)}

ANALYSIS:\n${JSON.stringify(args.analysis)}

CAREER EVIDENCE PROFILE:\n${JSON.stringify(args.profile)}

APPROVED MASTER RESUME TEXT:\n${args.masterResumeText.slice(0, 80000)}`,
  });
  return object;
}

const coverSchema = z.object({
  salutation: z.string(),
  paragraphs: z.array(z.string()).min(3).max(6),
  closing: z.string(),
  optimizationScore: z.number().min(0).max(100),
});

export async function generateCoverLetter(args: {
  job: Job;
  profile: CareerEvidenceProfile;
  resume: TailoredResumeContent;
}): Promise<CoverLetterContent> {
  const { object } = await generateObject({
    model: model(),
    schema: coverSchema,
    providerOptions: gatewayOptions,
    prompt: `Write a customized one-page cover letter for this role.

RULES:
- 300–400 words.
- Direct, natural, senior-level writing.
- Do not use "I am thrilled to apply", "I believe I would be a great fit", or "I am passionate about".
- Do not invent company culture, relationships, hiring-manager names, qualifications, technologies, or accomplishments.
- Use 1–2 measurable accomplishments only when supported by the career profile.
- Do not merely summarize the resume.
- If no reliable hiring-manager name is supplied, use "Hiring Team".

JOB:\n${JSON.stringify(args.job)}
CAREER PROFILE:\n${JSON.stringify(args.profile)}
TAILORED RESUME:\n${JSON.stringify(args.resume)}`,
  });
  return object;
}
