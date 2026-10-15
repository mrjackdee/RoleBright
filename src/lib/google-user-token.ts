import { assertExternalActionsAllowed } from './staging-safety';
import 'server-only';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { decryptSecret, encryptSecret } from './auth';

const FILE_NAME = '.jd-google-user-token.json';

function rootId(): string {
  const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!root) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured.');
  return root;
}

function serviceAccountDrive() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('Google service-account credentials are not configured for token bootstrap reads.');
  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

function userDrive(refreshToken: string, accessToken?: string) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Google OAuth is not configured.');
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken, access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

async function findTokenFile(drive: ReturnType<typeof google.drive>, root: string) {
  const escaped = FILE_NAME.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and '${root}' in parents and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 10,
  });
  return res.data.files?.[0];
}

export async function saveGoogleUserRefreshToken(refreshToken: string, accessToken?: string) {
  assertExternalActionsAllowed();
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) throw new Error('APP_SESSION_SECRET is not configured.');
  const root = rootId();
  const drive = userDrive(refreshToken, accessToken);
  const existing = await findTokenFile(drive, root);
  const encrypted = await encryptSecret(refreshToken, secret);
  const body = Readable.from(Buffer.from(JSON.stringify({ encrypted, updatedAt: new Date().toISOString() })));

  if (existing?.id) {
    await drive.files.update({
      fileId: existing.id,
      media: { mimeType: 'application/json', body },
      fields: 'id',
    });
    return;
  }

  await drive.files.create({
    requestBody: { name: FILE_NAME, parents: [root] },
    media: { mimeType: 'application/json', body },
    fields: 'id',
  });
}

export async function loadGoogleUserRefreshToken(): Promise<string | undefined> {
  assertExternalActionsAllowed();
  if (process.env.GOOGLE_USER_REFRESH_TOKEN) return process.env.GOOGLE_USER_REFRESH_TOKEN;
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) return undefined;
  const root = rootId();
  const drive = serviceAccountDrive();
  const existing = await findTokenFile(drive, root);
  if (!existing?.id) return undefined;
  const res = await drive.files.get({ fileId: existing.id, alt: 'media' }, { responseType: 'arraybuffer' });
  const raw = JSON.parse(Buffer.from(res.data as ArrayBuffer).toString('utf8')) as { encrypted?: string };
  if (!raw.encrypted) return undefined;
  return decryptSecret(raw.encrypted, secret);
}
