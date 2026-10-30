import { mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Index, type SourceRow, type AttachmentRow } from './db';
import { AppError, hash, readVerified, safePath, writeOnce } from './core';

export interface ManifestEntry {
  id: number; sha256: string; original: string; document: string; json: string;
  date_raw: string | null; date_utc: string | null; message_id: string | null;
  sources: SourceRow[]; attachments: (AttachmentRow & { exported: string })[];
}
export interface Manifest { version: 1; case: string; collection: string; created: string; selection: number[]; entries: ManifestEntry[]; files: { path: string; sha256: string; size: number }[] }
const encode = (s: string): string => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_[\]{}()!#+|~-]/g,'\\$&');
const inert = (s: string): string => s.split(/\r?\n/).map(line => `    ${line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'')}`).join('\n');
// Prefix formula-like values for spreadsheet-safe CSV while JSON preserves their exact values.
const csv = (s: unknown): string => { let v = String(s ?? ''); if (/^[\s]*[=+@-]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g,'""')}"`; };
export function caseName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw new AppError('INVALID_CASE_NAME');
  return name;
}
export async function exportCollection(root: string, index: Index, name: string, ids: number[]): Promise<string> {
  caseName(name);
  ids = [...new Set(ids)];
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
  const messages = ids.map(id => index.message(id));
  const collection = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  const parent = await safePath(root, `collections/${name}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await safePath(root, `collections/${name}/.staging-${collection}`);
  const final = await safePath(root, `collections/${name}/${collection}`);
  await mkdir(staging, { mode: 0o700 });
  const manifest: Manifest = { version: 1, case: name, collection, created: new Date().toISOString(), selection: ids, entries: [], files: [] };
  const add = async (path: string, bytes: Buffer | string) => {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeOnce(staging,path,data); manifest.files.push({ path, sha256: hash(data), size: data.length });
  };
  try {
    const rows: unknown[][] = [['id','sha256','date_utc','subject','from','to','original','document']];
    const jsonRows: unknown[] = [];
    for (const m of messages) {
      const original = `originals/${m.sha256}.eml`, document = `documents/${m.id}.md`, json = `documents/${m.id}.json`;
      await add(original, await readVerified(root,m.path,m.sha256));
      const sources = index.sources(m.id);
      const attachments: ManifestEntry['attachments'] = [];
      for (const a of index.attachments(m.id)) {
        const exported = `attachments/${m.id}-${a.position}-${a.sha256}.bin`;
        await add(exported, await readVerified(root,a.path,a.sha256)); attachments.push({ ...a, exported });
      }
      const entry = { id: m.id, sha256: m.sha256, original, document, json, date_raw: m.date_raw, date_utc: m.date_utc, message_id: m.message_id, sources, attachments };
      manifest.entries.push(entry);
      const derived = { ...m, sources, attachments, original, document };
      await add(json, JSON.stringify(derived,null,2)+'\n');
      await add(document, `# Message ${m.id}\n\nSHA-256: ${m.sha256}\n\nOriginal: ${original}\n\n## Headers (derived)\n\n${inert(`Subject: ${m.subject}\nFrom: ${m.sender}\nTo: ${m.recipients}\nCc: ${m.cc}\nBcc: ${m.bcc}\nDate (original): ${m.date_raw ?? '(absent)'}\nDate (UTC): ${m.date_utc ?? '(unparseable)'}`)}\n\n## Body (derived, untrusted text)\n\n${inert(m.body)}\n\n## Attachments\n\n${attachments.map(a => `- ${encode(a.filename ?? '(unnamed)')} — ${a.sha256}`).join('\n')}\n`);
      rows.push([m.id,m.sha256,m.date_utc,m.subject,m.sender,m.recipients,original,document]); jsonRows.push(derived);
    }
    await add('index.json', JSON.stringify(jsonRows,null,2)+'\n');
    await add('index.csv', rows.map(row => row.map(csv).join(',')).join('\r\n')+'\r\n');
    await add('README.md', '# Evidence collection\n\nOriginals contain exact server-retrieved bytes. Documents and attachments are derivatives. manifest.json records SHA-256 for every payload file and links sources. This hash inventory is not a digital signature or proof of authenticity. Email contents are untrusted; do not execute attachments.\n');
    const bytes = Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    await writeOnce(staging,'manifest.json',bytes);
    await writeOnce(staging,'manifest.sha256',Buffer.from(hash(bytes)+'  manifest.json\n'));
    await rename(staging,final);
    return final;
  } catch (e) {
    // Keep incomplete staging for diagnosis; never advertise it as a completed collection.
    throw e;
  }
}

export async function verifyArchive(root: string, index: Index): Promise<number> {
  const integrity = index.db.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
  if (integrity.some(x => x.integrity_check !== 'ok') || index.db.query('PRAGMA foreign_key_check').all().length) throw new AppError('DATABASE_INTEGRITY_FAILED');
  for (const m of index.all()) {
    const bytes = await readVerified(root,m.path,m.sha256);
    if (bytes.length !== m.size || !index.sources(m.id).length) throw new AppError('ARCHIVE_INTEGRITY_FAILED');
    for (const a of index.attachments(m.id)) await readVerified(root,a.path,a.sha256);
  }
  index.db.exec("INSERT INTO message_fts(message_fts,rank) VALUES('integrity-check',1)");
  return index.all().length;
}

export async function verifyCollection(path: string): Promise<Manifest> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(await safePath(path,'manifest.json'));
  const sum = (await readFile(await safePath(path,'manifest.sha256'),'utf8')).split(' ')[0];
  if (hash(raw) !== sum) throw new AppError('MANIFEST_HASH_MISMATCH');
  const m = JSON.parse(raw.toString()) as Manifest;
  if (m.version !== 1 || !Array.isArray(m.files) || !m.entries?.length || !m.selection?.length) throw new AppError('INVALID_MANIFEST');
  caseName(m.case);
  const paths = new Set<string>();
  for (const f of m.files) {
    if (paths.has(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new AppError('INVALID_MANIFEST');
    paths.add(f.path);
    if ((await readVerified(path,f.path,f.sha256)).length !== f.size) throw new AppError('COLLECTION_SIZE_MISMATCH');
  }
  for (const e of m.entries) {
    if (!m.selection.includes(e.id) || !e.sources.length || !paths.has(e.original) || !paths.has(e.document) || !paths.has(e.json) || m.files.find(f => f.path === e.original)?.sha256 !== e.sha256) throw new AppError('INVALID_MANIFEST');
    for (const a of e.attachments) if (m.files.find(f => f.path === a.exported)?.sha256 !== a.sha256) throw new AppError('INVALID_MANIFEST');
  }
  if (m.selection.length !== m.entries.length || new Set(m.selection).size !== m.selection.length) throw new AppError('INVALID_MANIFEST');
  // Extra files are never silently included in an upload.
  return m;
}
