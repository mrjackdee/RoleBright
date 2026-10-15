import { assertExternalActionsAllowed } from './staging-safety';
import 'server-only';
import { nanoid } from 'nanoid';
import type { Analysis, ApplicationPackage, CoverLetterContent, Job } from './types';
import { getState, updateState } from './storage/state';
import { generateCoverLetter, tailorResume } from './ai';
import { getMasterResumeText, getMasterResumeById } from './career';
import { analysisDocx, coverLetterDocx, jobDescriptionDocx, resumeDocx } from './documents/docx';
import { ensureFolder, uploadBuffer, findFileByName } from './storage/google';
import { safeFilePart, normalizeText, clamp } from './utils';
import { notifyApplicationPackage } from './notifications';

function latestAnalysis(analyses: Analysis[], jobId: string): Analysis | undefined {
  return analyses.filter(a => a.jobId === jobId).sort((a, b) => b.analysisDate.localeCompare(a.analysisDate))[0];
}

function atsAfter(job: Job, resumeText: string, analysis: Analysis): number {
  const important = new Set([...analysis.keywordCoverage, ...analysis.missingKeywords].map(normalizeText));
  const text = normalizeText(resumeText);
  let hits = 0;
  for (const term of important) if (term && text.includes(term)) hits++;
  const keywordScore = important.size ? hits / important.size * 100 : analysis.atsScore;
  return clamp(analysis.atsScore * 0.45 + keywordScore * 0.4 + 15);
}

function qa(job: Job, resume: { candidateName?: string; summary?: string; sections?: unknown[]; excludedUnsupportedKeywords?: string[] }, cover: CoverLetterContent, ats: number): string[] {
  const failures: string[] = [];
  const resumeBlob = JSON.stringify(resume).toLowerCase();
  const coverBlob = JSON.stringify(cover).toLowerCase();
  if (!resume.candidateName || !resume.summary || !resume.sections?.length) failures.push('Resume is missing required sections.');
  if (/sabbatical/.test(resumeBlob)) failures.push('Prohibited sabbatical section detected.');
  if (!coverBlob.includes(job.company.toLowerCase())) failures.push('Cover letter does not reference the correct employer.');
  if (!coverBlob.includes(job.title.toLowerCase().split(/[,|-]/)[0].trim())) failures.push('Cover letter may not reference the correct role.');
  if (resume.excludedUnsupportedKeywords?.some((k: string) => resumeBlob.includes(normalizeText(k)))) failures.push('Unsupported keyword was reintroduced into resume content.');
  if (ats < 90) failures.push(`ATS score after tailoring is below 90 (${ats}).`);
  return failures;
}

export async function prepareApplication(jobId: string, forceNewVersion = false): Promise<ApplicationPackage> {
  assertExternalActionsAllowed();
  const state = await getState();
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) throw new Error('Job not found.');
  const analysis = latestAnalysis(state.analyses, jobId);
  if (!analysis) throw new Error('Job has not been analyzed.');
  if (!state.careerProfile) throw new Error('Career Evidence Profile is not configured.');

  const existing = state.applicationPackages.filter(p => p.jobId === jobId).sort((a, b) => b.version - a.version);
  if (!forceNewVersion) {
    const ready = existing.find(p => p.packageStatus === 'READY_TO_APPLY' && !p.superseded);
    if (ready) return ready;
  }
  const version = (existing[0]?.version ?? 0) + 1;
  const master = state.baselineResumeId ? await getMasterResumeById(state.baselineResumeId) : await getMasterResumeText(analysis.recommendedMasterResume);
  const tailored = await tailorResume({ job, profile: state.careerProfile, masterResumeText: master.text, analysis });
  const cover = await generateCoverLetter({ job, profile: state.careerProfile, resume: tailored });
  const resumeText = JSON.stringify(tailored);
  const atsScoreAfter = atsAfter(job, resumeText, analysis);
  const failures = qa(job, tailored, cover, atsScoreAfter);

  const resumeBuffer = await resumeDocx(tailored);
  const coverBuffer = await coverLetterDocx(cover, tailored.candidateName, tailored.contactLine, job);
  const jdBuffer = await jobDescriptionDocx(job);
  const analysisBuffer = await analysisDocx(job, analysis);

  let baseFolder = process.env.GOOGLE_APPLICATION_PACKAGES_FOLDER_ID;
  if (!baseFolder) {
    const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!root) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured.');
    const found = await findFileByName('02 - Application Packages', root, 'application/vnd.google-apps.folder');
    if (!found?.id) throw new Error('Google Drive application packages folder was not found.');
    baseFolder = found.id;
  }
  const folderName = `${safeFilePart(job.company).replace(/_/g, ' ')} - ${safeFilePart(job.title).replace(/_/g, ' ')}${job.externalId ? ` - ${safeFilePart(job.externalId)}` : ''}`;
  const jobFolder = await ensureFolder(folderName, baseFolder);
  const versionFolder = await ensureFolder(`v${version}`, jobFolder.id);
  const company = safeFilePart(job.company);
  const role = safeFilePart(job.title);
  const req = job.externalId ? `_${safeFilePart(job.externalId)}` : '';
  const prefix = `Jack_Darnell_Givens_${company}_${role}${req}`;

  const [resumeFile, coverFile, jdFile, analysisFile] = await Promise.all([
    uploadBuffer({ name: `${prefix}_Resume.docx`, parentId: versionFolder.id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: resumeBuffer }),
    uploadBuffer({ name: `${prefix}_Cover_Letter.docx`, parentId: versionFolder.id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: coverBuffer }),
    uploadBuffer({ name: `${prefix}_Job_Description.docx`, parentId: versionFolder.id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: jdBuffer }),
    uploadBuffer({ name: `${prefix}_Application_Analysis.docx`, parentId: versionFolder.id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: analysisBuffer }),
  ]);

  const pkg: ApplicationPackage = {
    id: nanoid(), jobId, analysisId: analysis.id, version,
    masterResumeSource: master.name,
    tailoredResumeVersion: `${prefix}_Resume.docx`,
    coverLetterVersion: `${prefix}_Cover_Letter.docx`,
    jobDescriptionSnapshot: `${prefix}_Job_Description.docx`,
    generatedDate: new Date().toISOString(),
    qaStatus: failures.length ? 'FAILED' : 'PASSED',
    atsScoreBefore: analysis.atsScore,
    atsScoreAfter,
    coverLetterScore: cover.optimizationScore,
    keyModifications: tailored.modifications,
    googleDriveFolderId: versionFolder.id,
    googleDriveFolderUrl: versionFolder.url,
    resumeFileId: resumeFile.id, resumeUrl: resumeFile.url,
    coverLetterFileId: coverFile.id, coverLetterUrl: coverFile.url,
    jobDescriptionFileId: jdFile.id, jobDescriptionUrl: jdFile.url,
    analysisFileId: analysisFile.id, analysisUrl: analysisFile.url,
    packageStatus: failures.length ? 'FAILED' : 'READY_TO_APPLY',
    superseded: false,
    submitted: false,
  };

  await updateState(current => {
    if (!failures.length) current.applicationPackages.filter(p => p.jobId === jobId && !p.submitted).forEach(p => { p.superseded = true; if (p.packageStatus === 'READY_TO_APPLY') p.packageStatus = 'SUPERSEDED'; });
    current.applicationPackages.push(pkg);
    let app = current.applications.find(a => a.jobId === jobId);
    if (!app) {
      app = { id: nanoid(), jobId, status: failures.length ? 'PREPARING' : 'READY_TO_APPLY', interviewDates: [], notes: [], updatedAt: new Date().toISOString() };
      current.applications.push(app);
    } else {
      app.status = failures.length ? 'PREPARING' : 'READY_TO_APPLY';
      app.updatedAt = new Date().toISOString();
    }
  });

  if (failures.length) throw new Error(`Application package QA failed: ${failures.join(' ')}`);
  if (state.notificationsEnabled !== false) { try { await notifyApplicationPackage(job, pkg); } catch (error) { console.warn('Application notification failed', error instanceof Error ? error.message : error); } }
  return pkg;
}
