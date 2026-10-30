import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, link, unlink, chmod, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';

export class AppError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'AppError'; }
}
export const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
export type Log = (event: string, counts?: Record<string, number>) => void;
export const log: Log = (event, counts = {}) => console.error(JSON.stringify({ time: new Date().toISOString(), event, ...counts }));

export function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AppError('UNSAFE_PATH');
  return target;
}

// Reject symlink/junction traversal, including existing parent components.
export async function safePath(root: string, path: string): Promise<string> {
  const target = inside(root, path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const parts = relative(resolve(root), target).split(/[\\/]/);
  let current = canonical;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new AppError('SYMLINK_PATH');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return current;
}

export async function writeOnce(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const target = await safePath(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const check = async () => {
    if (hash(await readFile(target)) !== hash(bytes)) throw new AppError('OBJECT_HASH_MISMATCH');
  };
  try { await lstat(target); await check(); return; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temp = `${target}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync();
  } finally { await file.close(); }
  try {
    // A hard link publishes a complete file atomically without replacing an existing object.
    await link(temp, target);
    await chmod(target, 0o400);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') await check(); else throw e;
  } finally { await unlink(temp).catch(() => {}); }
}

export async function readVerified(root: string, path: string, expected: string): Promise<Buffer> {
  const bytes = await readFile(await safePath(root, path));
  if (hash(bytes) !== expected) throw new AppError('OBJECT_HASH_MISMATCH');
  return bytes;
}

export async function withWriter<T>(root: string, action: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = await safePath(root, '.writer.sqlite');
  for (const suffix of ['-journal','-wal','-shm']) await safePath(root, `.writer.sqlite${suffix}`);
  let lock: Database | undefined;
  try {
    lock = new Database(path, { create: true, strict: true });
    // Separate from index.sqlite: hold the OS-backed lock across the async action
    // without blocking the index's own transactions. Process death releases it.
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (e) {
    lock?.close();
    const code = (e as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') throw new AppError('ARCHIVE_LOCKED');
    throw new AppError('ARCHIVE_LOCK_IO_ERROR');
  }
  try {
    await retireLegacyLock(root);
    return await action();
  } finally {
    // Do not delete the SQLite lock file: replacing it could create two distinct
    // OS locks for concurrent processes. Only release this connection's lock.
    try { lock.exec('ROLLBACK;'); } finally { lock.close(); }
  }
}

async function retireLegacyLock(root: string): Promise<void> {
  const path = await safePath(root, '.writer.lock');
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw new AppError('ARCHIVE_LOCK_IO_ERROR'); }
  let pid: number;
  try {
    const value = JSON.parse(bytes.toString()) as { pid?: unknown };
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error();
    pid = value.pid;
  } catch { throw new AppError('LEGACY_LOCK_INVALID'); }
  try {
    process.kill(pid, 0); // Existence check only; never terminate the process.
    throw new AppError('ARCHIVE_LOCKED');
  } catch (e) {
    // Reclaim only a demonstrably dead owner, never an inaccessible or reused PID.
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
      if (e instanceof AppError) throw e;
      throw new AppError('ARCHIVE_LOCKED');
    }
  }
  // All new-version reclamation is serialized by the SQLite lock above.
  if (!(await readFile(path)).equals(bytes)) throw new AppError('ARCHIVE_LOCKED');
  await unlink(path);
}

export class RateLimit {
  private last = 0;
  constructor(private readonly interval: number) {}
  async wait(): Promise<void> {
    await sleep(Math.max(0, this.last + this.interval - Date.now())); this.last = Date.now();
  }
}

export async function retry<T>(action: () => Promise<T>, attempts: number, report: Log, delay = 500): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await action(); }
    catch (e) {
      if (e instanceof AppError || attempt >= attempts) throw e;
      report('retry', { attempt });
      await sleep(Math.min(30_000, delay * 2 ** (attempt - 1)) + Math.random() * delay);
    }
  }
}
