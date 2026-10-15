import 'server-only';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { loadGoogleUserRefreshToken } from '../google-user-token';

export function googleConfigured(): boolean {
  if (process.env.APP_ENV === 'staging') return false;
  const oauth = Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  const bootstrap = Boolean(process.env.GOOGLE_USER_REFRESH_TOKEN || (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY));
  return Boolean(oauth && bootstrap && process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID);
}

export async function googleAuth() {
  if (process.env.APP_ENV === 'staging') throw new Error('Google Drive is disabled in isolated staging.');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google OAuth is not configured.');
  const refreshToken = await loadGoogleUserRefreshToken();
  if (!refreshToken) throw new Error('Google Drive is not authorized yet. Sign in with Google once to complete setup.');
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export async function driveClient() {
  return google.drive({ version: 'v3', auth: await googleAuth() });
}

export async function getFileMetadata(fileId: string) {
  const drive = await driveClient();
  const res = await drive.files.get({ fileId, fields: 'id,name,mimeType,webViewLink,modifiedTime,parents,size' });
  return res.data;
}

export async function findFileByName(name: string, parentId: string, mimeType?: string) {
  const drive = await driveClient();
  const escaped = name.replace(/'/g, "\\'");
  const clauses = [`name = '${escaped}'`, `'${parentId}' in parents`, 'trashed = false'];
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  const res = await drive.files.list({ q: clauses.join(' and '), fields: 'files(id,name,mimeType,webViewLink,modifiedTime,parents)', pageSize: 20 });
  return res.data.files?.[0];
}

export async function ensureFolder(name: string, parentId: string): Promise<{ id: string; url: string }> {
  const existing = await findFileByName(name, parentId, 'application/vnd.google-apps.folder');
  if (existing?.id) return { id: existing.id, url: existing.webViewLink ?? `https://drive.google.com/drive/folders/${existing.id}` };
  const drive = await driveClient();
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id,webViewLink',
  });
  if (!created.data.id) throw new Error(`Unable to create Drive folder ${name}`);
  return { id: created.data.id, url: created.data.webViewLink ?? `https://drive.google.com/drive/folders/${created.data.id}` };
}

export async function copyFileToFolder(args: { fileId: string; name: string; parentId: string }): Promise<{ id: string; url: string }> {
  const drive = await driveClient();
  const copied = await drive.files.copy({
    fileId: args.fileId,
    requestBody: { name: args.name, parents: [args.parentId] },
    fields: 'id,webViewLink',
  });
  if (!copied.data.id) throw new Error(`Unable to copy Drive file ${args.name}`);
  return { id: copied.data.id, url: copied.data.webViewLink ?? `https://drive.google.com/open?id=${copied.data.id}` };
}

export async function uploadBuffer(args: {
  name: string;
  parentId: string;
  mimeType: string;
  buffer: Buffer;
  replaceFileId?: string;
}): Promise<{ id: string; url: string }> {
  const drive = await driveClient();
  if (args.replaceFileId) {
    const updated = await drive.files.update({
      fileId: args.replaceFileId,
      requestBody: { name: args.name },
      media: { mimeType: args.mimeType, body: Readable.from(args.buffer) },
      fields: 'id,webViewLink',
    });
    if (!updated.data.id) throw new Error(`Unable to update Drive file ${args.name}`);
    return { id: updated.data.id, url: updated.data.webViewLink ?? `https://drive.google.com/open?id=${updated.data.id}` };
  }
  const created = await drive.files.create({
    requestBody: { name: args.name, parents: [args.parentId] },
    media: { mimeType: args.mimeType, body: Readable.from(args.buffer) },
    fields: 'id,webViewLink',
  });
  if (!created.data.id) throw new Error(`Unable to upload Drive file ${args.name}`);
  return { id: created.data.id, url: created.data.webViewLink ?? `https://drive.google.com/open?id=${created.data.id}` };
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = await driveClient();
  const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType' });
  const mime = meta.data.mimeType ?? '';
  if (mime === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { responseType: 'arraybuffer' });
    return Buffer.from(res.data as ArrayBuffer);
  }
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data as ArrayBuffer);
}

export async function listFolder(parentId: string) {
  const drive = await driveClient();
  const res = await drive.files.list({
    q: `'${parentId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,size)',
    pageSize: 200,
    orderBy: 'modifiedTime desc',
  });
  return res.data.files ?? [];
}
