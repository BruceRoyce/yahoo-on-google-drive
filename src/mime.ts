import { simpleParser } from 'mailparser';
import { hash } from './core';

export interface ParsedAttachment { position: number; filename: string | null; type: string; sha256: string; bytes: Buffer; path: string }
export interface Parsed {
  sha256: string; size: number; path: string; messageId: string | null; subject: string;
  addresses: string; from: string; to: string; cc: string; bcc: string;
  dateRaw: string | null; dateUtc: string | null; body: string; attachments: ParsedAttachment[];
}
export async function parse(bytes: Buffer): Promise<Parsed> {
  const mail = await simpleParser(bytes, {
    skipHtmlToText: false, skipTextToHtml: true, skipTextLinks: true,
    skipImageLinks: true, maxHtmlLengthToParse: 10_000_000, checksumAlgo: 'sha256',
  });
  // Extract from original bytes: do not substitute MailParser's normalized date representation.
  const header = bytes.toString('latin1').split(/\r?\n\r?\n/, 1)[0] ?? '';
  const dateRaw = header.match(/^Date:([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/im)?.[1] ?? null;
  const date = dateRaw ? new Date(dateRaw.replace(/\r?\n[ \t]+/g, ' ').trim()) : null;
  const text = (value: typeof mail.to) => Array.isArray(value) ? value.map(x => x.text).join(', ') : value?.text ?? '';
  const from = text(mail.from), to = text(mail.to), cc = text(mail.cc), bcc = text(mail.bcc);
  const sha256 = hash(bytes);
  return {
    sha256, size: bytes.length, path: `objects/${sha256.slice(0, 2)}/${sha256}.eml`,
    messageId: mail.messageId ?? null, subject: mail.subject ?? '',
    addresses: [from, to, cc, bcc].join('\n'), from, to, cc, bcc, dateRaw,
    dateUtc: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    body: mail.text ?? '',
    attachments: mail.attachments.map((a, position) => {
      const sha256 = hash(a.content);
      return { position, filename: a.filename ?? null, type: a.contentType, sha256, bytes: a.content,
        path: `attachments/${sha256.slice(0, 2)}/${sha256}.bin` };
    }),
  };
}
