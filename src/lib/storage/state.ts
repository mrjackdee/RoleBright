import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDefaultState } from '../default-state';
import { stagingDatabase } from './staging-db';
import type { AppState } from '../types';
import { findFileByName, googleConfigured, uploadBuffer, downloadFile } from './google';

const STATE_FILE = '.jackdee-job-search-state.json';
const localPath = path.join(process.cwd(), 'data', 'state.json');

function shouldUseLocalStorage(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' || process.env.USE_LOCAL_STATE === 'true';
}

export class StorageNotConfiguredError extends Error {}

async function readLocal(): Promise<AppState> {
  try {
    const raw = await fs.readFile(localPath, 'utf8');
    return JSON.parse(raw) as AppState;
  } catch {
    const state = createDefaultState();
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, JSON.stringify(state, null, 2));
    return state;
  }
}

async function writeLocal(state: AppState): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, JSON.stringify(state, null, 2));
}

async function readDrive(): Promise<AppState> {
  if (!googleConfigured()) throw new StorageNotConfiguredError('Google Drive storage is not configured.');
  const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
  const existing = await findFileByName(STATE_FILE, root);
  if (!existing?.id) {
    const initial = createDefaultState();
    await uploadBuffer({ name: STATE_FILE, parentId: root, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial, null, 2)) });
    return initial;
  }
  const bytes = await downloadFile(existing.id);
  return JSON.parse(bytes.toString('utf8')) as AppState;
}

async function writeDrive(state: AppState): Promise<void> {
  if (!googleConfigured()) throw new StorageNotConfiguredError('Google Drive storage is not configured.');
  const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
  const existing = await findFileByName(STATE_FILE, root);
  await uploadBuffer({
    name: STATE_FILE,
    parentId: root,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(state, null, 2)),
    replaceFileId: existing?.id ?? undefined,
  });
}

export async function getState(): Promise<AppState> {
  if (process.env.APP_ENV === 'staging') return stagingDatabase().read();
  return shouldUseLocalStorage() ? readLocal() : readDrive();
}

export async function saveState(state: AppState): Promise<void> {
  if (process.env.APP_ENV === 'staging') return stagingDatabase().save(state);
  state.updatedAt = new Date().toISOString();
  return shouldUseLocalStorage() ? writeLocal(state) : writeDrive(state);
}

let queue: Promise<unknown> = Promise.resolve();

export async function updateState<T>(mutator: (state: AppState) => Promise<T> | T): Promise<T> {
  if (process.env.APP_ENV === 'staging') return stagingDatabase().update(mutator);
  let result!: T;
  const task = queue.then(async () => {
    const state = await getState();
    result = await mutator(state);
    await saveState(state);
  });
  queue = task.catch(() => undefined);
  await task;
  return result;
}
