import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync, lstatSync } from 'node:fs';
import type { Parsed } from './mime';
import { AppError } from './core';

export interface MessageRow {
  id: number; sha256: string; size: number; path: string; message_id: string | null;
  subject: string; addresses: string; sender: string; recipients: string; cc: string; bcc: string;
  date_raw: string | null; date_utc: string | null; body: string; archived_at: string;
}
export interface SourceRow { account_id: string; mailbox: string; uidvalidity: string; uid: number; internal_date: string; internal_date_raw: string }
export interface AttachmentRow { position: number; filename: string | null; mime_type: string; sha256: string; path: string; size: number }
export interface Search { query?: string; address?: string; subject?: string; since?: string; until?: string; limit?: number; offset?: number }

export class Index {
  readonly db: Database;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of ['index.sqlite','index.sqlite-wal','index.sqlite-shm']) {
      try { if (lstatSync(join(root,name)).isSymbolicLink()) throw new AppError('SYMLINK_DATABASE'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    }
    this.db = new Database(join(root, 'index.sqlite'), { create: true, strict: true });
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = (this.db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 2) { this.db.close(); throw new AppError('NEWER_DATABASE_VERSION'); }
    if (version === 0) this.db.transaction(() => this.db.exec(`
      CREATE TABLE accounts(id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, login TEXT NOT NULL);
      CREATE TABLE mailboxes(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), path TEXT NOT NULL,
        UNIQUE(account_id,path));
      CREATE TABLE generations(mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id), uidvalidity TEXT NOT NULL,
        first_observed TEXT NOT NULL, PRIMARY KEY(mailbox_id,uidvalidity));
      CREATE TABLE messages(id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, path TEXT NOT NULL,
        message_id TEXT, subject TEXT NOT NULL, addresses TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL,
        cc TEXT NOT NULL, bcc TEXT NOT NULL, date_raw TEXT, date_utc TEXT, body TEXT NOT NULL, archived_at TEXT NOT NULL);
      CREATE TABLE occurrences(mailbox_id INTEGER NOT NULL, uidvalidity TEXT NOT NULL, uid INTEGER NOT NULL CHECK(uid>0),
        message_id INTEGER NOT NULL REFERENCES messages(id), internal_date TEXT NOT NULL, internal_date_raw TEXT NOT NULL,
        PRIMARY KEY(mailbox_id,uidvalidity,uid), FOREIGN KEY(mailbox_id,uidvalidity) REFERENCES generations(mailbox_id,uidvalidity));
      CREATE TABLE attachments(message_id INTEGER NOT NULL REFERENCES messages(id), position INTEGER NOT NULL,
        filename TEXT, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(message_id,position));
      CREATE INDEX occurrence_message ON occurrences(message_id);
      CREATE INDEX message_date ON messages(date_utc);
      CREATE VIRTUAL TABLE message_fts USING fts5(subject,addresses,body,content='messages',content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER message_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_fts(rowid,subject,addresses,body) VALUES(new.id,new.subject,new.addresses,new.body); END;
      PRAGMA user_version=1;
    `))();
    if (version < 2) this.db.transaction(() => this.db.exec(`
      CREATE TABLE sync_boundaries(account_id TEXT PRIMARY KEY, since_utc TEXT NOT NULL);
      PRAGMA user_version=2;
    `))();
  }
  close(): void { this.db.close(); }
  syncBoundary(accountId: string): string | null {
    const row = this.db.query('SELECT since_utc FROM sync_boundaries WHERE account_id=?').get(accountId) as { since_utc: string } | null;
    return row?.since_utc ?? null;
  }
  setSyncBoundary(accountId: string, since: string): void {
    this.db.query(`INSERT INTO sync_boundaries VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET since_utc=excluded.since_utc`).run(accountId,since);
  }
  mailbox(account: { id: string; host: string; port: number; login: string }, path: string, validity: string): number {
    return this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO accounts VALUES(?,?,?,?)').run(account.id, account.host, account.port, account.login);
      this.db.query('INSERT OR IGNORE INTO mailboxes(account_id,path) VALUES(?,?)').run(account.id, path);
      const row = this.db.query('SELECT id FROM mailboxes WHERE account_id=? AND path=?').get(account.id, path) as { id: number };
      this.db.query('INSERT OR IGNORE INTO generations VALUES(?,?,?)').run(row.id, validity, new Date().toISOString());
      return row.id;
    })();
  }
  known(accountId: string, path: string, validity: string): Set<number> {
    return new Set((this.db.query(`SELECT o.uid FROM occurrences o JOIN mailboxes b ON b.id=o.mailbox_id
      WHERE b.account_id=? AND b.path=? AND o.uidvalidity=?`).all(accountId, path, validity) as { uid: number }[]).map(x => x.uid));
  }
  record(mailbox: number, validity: string, uid: number, internalDate: string, rawDate: string, m: Parsed): void {
    this.db.transaction(() => {
      this.db.query(`INSERT OR IGNORE INTO messages(sha256,size,path,message_id,subject,addresses,sender,recipients,cc,bcc,date_raw,date_utc,body,archived_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(m.sha256,m.size,m.path,m.messageId,m.subject,m.addresses,m.from,m.to,m.cc,m.bcc,m.dateRaw,m.dateUtc,m.body,new Date().toISOString());
      const { id } = this.db.query('SELECT id FROM messages WHERE sha256=?').get(m.sha256) as { id: number };
      for (const a of m.attachments) this.db.query('INSERT OR IGNORE INTO attachments VALUES(?,?,?,?,?,?,?)').run(id,a.position,a.filename,a.type,a.sha256,a.path,a.bytes.length);
      const old = this.db.query('SELECT message_id FROM occurrences WHERE mailbox_id=? AND uidvalidity=? AND uid=?').get(mailbox,validity,uid) as { message_id: number } | null;
      if (old && old.message_id !== id) throw new AppError('UID_CONTENT_CHANGED');
      this.db.query('INSERT OR IGNORE INTO occurrences VALUES(?,?,?,?,?,?)').run(mailbox,validity,uid,id,internalDate,rawDate);
    })();
  }
  search(s: Search): MessageRow[] {
    const clauses: string[] = [], values: (string | number)[] = [];
    if (s.query) {
      // Literal terms joined by AND: user input is neither SQL nor FTS syntax.
      const terms = s.query.match(/[\p{L}\p{N}_]+/gu);
      if (!terms?.length) throw new AppError('EMPTY_SEARCH_TERMS');
      clauses.push('m.id IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)');
      values.push(terms.map(x => `"${x}"`).join(' AND '));
    }
    for (const [column, value] of [['addresses',s.address],['subject',s.subject]] as const) {
      if (value) { clauses.push(`instr(lower(m.${column}),lower(?))>0`); values.push(value); }
    }
    if (s.since) { clauses.push('m.date_utc>=?'); values.push(s.since); }
    if (s.until) { clauses.push('m.date_utc<?'); values.push(s.until); }
    const limit = s.limit ?? 100, offset = s.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_PAGINATION');
    return this.db.query(`SELECT m.* FROM messages m ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''}
      ORDER BY m.date_utc,m.id LIMIT ? OFFSET ?`).all(...values,limit,offset) as MessageRow[];
  }
  message(id: number): MessageRow {
    const row = this.db.query('SELECT * FROM messages WHERE id=?').get(id) as MessageRow | null;
    if (!row) throw new AppError('MESSAGE_NOT_FOUND'); return row;
  }
  sources(id: number): SourceRow[] {
    return this.db.query(`SELECT b.account_id,b.path mailbox,o.uidvalidity,o.uid,o.internal_date,o.internal_date_raw
      FROM occurrences o JOIN mailboxes b ON o.mailbox_id=b.id WHERE o.message_id=? ORDER BY b.account_id,b.path,o.uidvalidity,o.uid`).all(id) as SourceRow[];
  }
  attachments(id: number): AttachmentRow[] { return this.db.query('SELECT position,filename,mime_type,sha256,path,size FROM attachments WHERE message_id=? ORDER BY position').all(id) as AttachmentRow[]; }
  all(): MessageRow[] { return this.db.query('SELECT * FROM messages ORDER BY id').all() as MessageRow[]; }
}
