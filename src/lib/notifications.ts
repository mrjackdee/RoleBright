import 'server-only';
import { google } from 'googleapis';
import { loadGoogleUserRefreshToken } from './google-user-token';
import type { ApplicationPackage, Job, SearchRun } from './types';

const TO = process.env.NOTIFICATION_EMAIL ?? 'jackdee.sync@gmail.com';

export function notificationsConfigured() {
  if (process.env.APP_ENV === 'staging') return false;
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.NOTIFICATION_EMAIL);
}

async function gmailClient() {
  if (process.env.APP_ENV === 'staging') throw new Error('Email delivery is disabled in staging.');
  const refreshToken = await loadGoogleUserRefreshToken();
  if (!refreshToken) throw new Error('Gmail notifications are not authorized yet. Sign in with Google once to grant notification access.');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth });
}

function encodeMessage(subject: string, html: string) {
  const message = [
    `To: ${TO}`,
    `From: Jack Dee Job Search Command Center <${TO}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}

export async function sendNotification(subject: string, html: string) {
  const gmail = await gmailClient();
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodeMessage(subject, html) } });
}

export async function notifySearchSummary(run: SearchRun, jobs: Job[]) {
  const top = jobs.slice(0, 10);
  const rows = top.map(j => `<li><strong>${j.company}</strong> | ${j.title} | ${j.location} | <a href="${j.applicationUrl}">Open posting</a></li>`).join('');
  await sendNotification(`Job search update: ${run.qualified} qualifying roles found`, `<p>The ${run.trigger.toLowerCase()} search completed with <strong>${run.qualified}</strong> qualifying roles.</p><ul>${rows || '<li>No new qualifying roles in this run.</li>'}</ul><p>Discovered: ${run.discovered} | Excluded: ${run.excluded} | Duplicates suppressed: ${run.duplicates}</p>`);
}

export async function notifyApplicationPackage(job: Job, pkg: ApplicationPackage) {
  await sendNotification(`Application package ready: ${job.company} | ${job.title}`, `<p>Your customized application package is ready for review.</p><p><strong>${job.company}</strong><br/>${job.title}</p><ul><li><a href="${pkg.resumeUrl}">Open customized resume</a></li><li><a href="${pkg.coverLetterUrl}">Open customized cover letter</a></li><li><a href="${pkg.googleDriveFolderUrl}">Open complete Google Drive package</a></li></ul><p>ATS optimization score: ${pkg.atsScoreAfter}/100 | Cover letter score: ${pkg.coverLetterScore}/100</p>`);
}
