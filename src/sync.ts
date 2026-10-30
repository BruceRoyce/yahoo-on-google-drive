import type { Config } from './config';
import { Index } from './db';
import { AppError, hash, retry, writeOnce, type Log } from './core';
import { parse } from './mime';
import type { TransportFactory } from './imap';
import { boundaryDate, DEFAULT_ARCHIVE_SINCE, utc } from './dates';

export interface BoundaryChange { requested: string; guarded: string }
export interface SyncOptions {
  folders?: string[]; since?: Date; dryRun?: boolean; retryDelay?: number;
  confirmEarlier?: (change: BoundaryChange) => Promise<boolean>;
}
export interface SyncStats { archived: number; skipped: number; vanished: number; pending: number; failed: number; excluded: number }
export async function sync(c: Config, index: Index, factory: TransportFactory, options: SyncOptions, report: Log): Promise<SyncStats> {
  const requested = boundaryDate(options.since ?? new Date(c.archiveSince));
  // Guard both configured and previously used boundaries, including config edits between runs.
  const guarded = [utc(DEFAULT_ARCHIVE_SINCE)!, c.archiveSince, index.syncBoundary(c.accountId) ?? ''].sort().at(-1)!;
  if (requested < guarded && (!options.confirmEarlier || !await options.confirmEarlier({ requested, guarded }))) {
    throw new AppError('EARLIER_SYNC_CONFIRMATION_REQUIRED');
  }
  const since = new Date(requested);
  const stats: SyncStats = { archived: 0, skipped: 0, vanished: 0, pending: 0, failed: 0, excluded: 0 };
  const folders = await retry(async () => {
    const client = factory();
    try { await client.connect(); return await client.folders(); } finally { await client.close(); }
  }, c.attempts, report, options.retryDelay);
  const chosen = options.folders ?? folders.map(f => f.path);
  if (chosen.some(path => !folders.some(f => f.path === path))) throw new AppError('FOLDER_NOT_SELECTABLE');
  // Persist before retrieval, so a partial run cannot silently relax a later boundary next time.
  if (!options.dryRun) index.setSyncBoundary(c.accountId, requested);
  for (const path of chosen) {
    try {
      await retry(async () => {
        const client = factory();
        try {
          await client.connect();
          const validity = await client.select(path);
          const known = index.known(c.accountId, path, validity);
          const uids = await client.uids(since);
          const mailbox = options.dryRun ? null : index.mailbox({ id: c.accountId, host: c.host, port: c.port, login: c.user }, path, validity);
          report('folder_started', { candidates: uids.length });
          for (const uid of uids) {
            if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('INVALID_UID');
            if (known.has(uid)) { stats.skipped++; continue; }
            if (options.dryRun) { stats.pending++; continue; }
            const message = await client.fetch(uid, c.maxBytes, since);
            if (!message) { stats.vanished++; continue; }
            if ('excluded' in message) { stats.excluded++; continue; }
            const internalDate = new Date(message.internalDate);
            if (!Number.isFinite(internalDate.getTime())) throw new AppError('INVALID_INTERNALDATE');
            if (internalDate < since) { stats.excluded++; continue; }
            if (message.source.length > c.maxBytes) throw new AppError('MESSAGE_SIZE_LIMIT');
            const sha = hash(message.source);
            // Persist raw bytes even if a malformed MIME message cannot be indexed on this run.
            await writeOnce(c.root, `objects/${sha.slice(0,2)}/${sha}.eml`, message.source);
            const parsed = await parse(message.source);
            for (const a of parsed.attachments) await writeOnce(c.root, a.path, a.bytes);
            index.record(mailbox!, validity, uid, message.internalDate, message.internalDateRaw, parsed);
            known.add(uid); stats.archived++;
            report('message_archived', { archived: stats.archived });
          }
        } finally { await client.close(); }
      }, c.attempts, report, options.retryDelay);
    } catch (e) {
      stats.failed++;
      report(e instanceof AppError ? e.code : 'FOLDER_OPERATION_FAILED');
      report('folder_failed', { failed: stats.failed });
    }
  }
  report('sync_complete', { ...stats });
  return stats;
}
