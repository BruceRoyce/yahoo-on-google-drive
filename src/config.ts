import { resolve } from 'node:path';
import { AppError, hash } from './core';
import { DEFAULT_ARCHIVE_SINCE, utc } from './dates';

export interface Config {
  root: string; host: string; port: number; user: string; password: string;
  interval: number; maxBytes: number; attempts: number; accountId: string;
  archiveSince: string;
}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new AppError('INVALID_CONFIGURATION');
  return n;
}
export function config(env: Record<string, string | undefined> = process.env, auth = false): Config {
  const user = (env.YAHOO_USER ?? '').trim();
  const password = env.YAHOO_APP_PASSWORD ?? '';
  const host = env.IMAP_HOST || 'imap.mail.yahoo.com';
  const port = integer(env.IMAP_PORT, 993, 1, 65535);
  if (auth && (!user || !password)) throw new AppError('YAHOO_CREDENTIALS_REQUIRED');
  return {
    root: resolve(env.ARCHIVE_DIR || './data'), host, port, user, password,
    archiveSince: utc(env.MAIL_ARCHIVE_SINCE ?? DEFAULT_ARCHIVE_SINCE)!,
    interval: integer(env.REQUEST_INTERVAL_MS, 300, 0, 60000),
    maxBytes: integer(env.MAX_MESSAGE_BYTES, 104857600, 1024, 1073741824),
    attempts: integer(env.RETRY_ATTEMPTS, 4, 1, 10),
    accountId: hash(JSON.stringify([host.toLowerCase(), port, user.toLowerCase()])),
  };
}
