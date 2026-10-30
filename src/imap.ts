import { ImapFlow } from 'imapflow';
import type { Config } from './config';
import { AppError, RateLimit } from './core';
import { boundaryDate } from './dates';

export interface Folder { path: string; specialUse: string | null }
export interface Retrieved { source: Buffer; internalDate: string; internalDateRaw: string }
export type Retrieval = Retrieved | { excluded: true } | null;
export interface MailTransport {
  connect(): Promise<void>; folders(): Promise<Folder[]>; select(path: string): Promise<string>;
  uids(since: Date): Promise<number[]>; fetch(uid: number, maxBytes: number, since: Date): Promise<Retrieval>;
  close(): Promise<void>;
}
export type TransportFactory = () => MailTransport;

export class YahooImap implements MailTransport {
  private readonly client: ImapFlow;
  private readonly rate: RateLimit;
  constructor(c: Config, createClient: (options: NonNullable<ConstructorParameters<typeof ImapFlow>[0]>) => ImapFlow = options => new ImapFlow(options)) {
    this.rate = new RateLimit(c.interval);
    this.client = createClient({
      host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      logger: false, emitLogs: false, disableAutoIdle: true, disableCompression: true,
      disableBinary: true, maxLiteralSize: c.maxBytes, maxResponseSize: c.maxBytes + 1_048_576,
      connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 120_000,
    });
    // Never expose the server's errors, which may contain account identifiers or message bytes.
    this.client.on('error', () => {});
  }
  async connect(): Promise<void> {
    await this.rate.wait();
    try { await this.client.connect(); }
    catch (e) {
      if ((e as { authenticationFailed?: boolean }).authenticationFailed) throw new AppError('IMAP_AUTHENTICATION_FAILED');
      const code=(e as NodeJS.ErrnoException).code ?? '';
      if (['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) throw new AppError('TLS_CERTIFICATE_FAILED');
      throw e;
    }
  }
  async folders(): Promise<Folder[]> {
    await this.rate.wait();
    return (await this.client.list()).filter(f => !f.flags.has('\\Noselect')).map(f => ({ path: f.path, specialUse: f.specialUse ?? null }));
  }
  async select(path: string): Promise<string> {
    await this.rate.wait();
    const mailbox = await this.client.mailboxOpen(path, { readOnly: true });
    if (!mailbox.readOnly || !mailbox.uidValidity) throw new AppError('READ_ONLY_MAILBOX_REQUIRED');
    return mailbox.uidValidity.toString();
  }
  async uids(since: Date): Promise<number[]> {
    boundaryDate(since);
    await this.rate.wait();
    // Never broaden the requested calendar boundary or fall back to SEARCH ALL.
    const result = await this.client.search({ since: since.toISOString().slice(0,10) }, { uid: true });
    if (!Array.isArray(result)) throw new Error('SEARCH_FAILED');
    return result.sort((a,b) => a-b);
  }
  async fetch(uid: number, maxBytes: number, since: Date): Promise<Retrieval> {
    boundaryDate(since);
    await this.rate.wait();
    const info = await this.client.fetchOne(String(uid), { uid: true, size: true, internalDate: true }, { uid: true });
    if (!info) return null;
    if (info.uid !== uid || info.size === undefined) throw new Error('INVALID_FETCH_METADATA');
    if (!info.internalDate) throw new Error('MISSING_INTERNALDATE');
    const internalDate = new Date(info.internalDate);
    if (!Number.isFinite(internalDate.getTime())) throw new Error('INVALID_INTERNALDATE');
    // Fetch metadata first: an out-of-range message must never have its body downloaded.
    if (internalDate < since) return { excluded: true };
    if (info.size > maxBytes) throw new AppError('MESSAGE_SIZE_LIMIT');
    await this.rate.wait();
    // ImapFlow uses BODY.PEEK[] for source; never FLAGS, STORE, MOVE, CLOSE or EXPUNGE.
    const msg = await this.client.fetchOne(String(uid), { uid: true, source: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    if (msg.uid !== uid || !msg.source || msg.source.length !== info.size || !msg.internalDate) throw new Error('INCOMPLETE_FETCH');
    if (msg.source.length > maxBytes) throw new AppError('MESSAGE_SIZE_LIMIT');
    const date = new Date(msg.internalDate);
    if (!Number.isFinite(date.getTime())) throw new Error('INVALID_INTERNALDATE');
    if (date.getTime() !== internalDate.getTime()) throw new AppError('INTERNALDATE_CHANGED');
    // ImapFlow exposes INTERNALDATE as a Date, so this representation is normalized.
    // The original RFC Date header and offset are retained independently from the original bytes.
    return { source: msg.source, internalDate: date.toISOString(), internalDateRaw: String(msg.internalDate) };
  }
  async close(): Promise<void> {
    // Socket close avoids CLOSE (which can expunge); no mutations are ever requested.
    this.client.close();
  }
}
