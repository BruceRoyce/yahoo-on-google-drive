import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, chmod, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config';
import { writeOnce, readVerified, inside, withWriter, retry, AppError, RateLimit } from '../src/core';
import { parse } from '../src/mime';
import { Index } from '../src/db';
import { exportCollection, verifyArchive, verifyCollection, caseName } from '../src/export';
import { sync } from '../src/sync';
import type { MailTransport, Retrieval } from '../src/imap';
import { YahooImap } from '../src/imap';
import { utc, main } from '../src/cli';

const roots: string[] = [];
const databases: Index[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true});
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(),'mail-test-')); roots.push(root);
  const c = config({ ARCHIVE_DIR: root, YAHOO_USER: 'synthetic@example.invalid', YAHOO_APP_PASSWORD: 'not-real', REQUEST_INTERVAL_MS: '0', RETRY_ATTEMPTS: '3' });
  const index = new Index(root); databases.push(index); return { root, c, index };
}
export const raw = (subject = 'Water ingress', id = '<duplicate@example.invalid>') => Buffer.from([
  'From: Tenant <tenant@example.invalid>', 'To: Landlord <landlord@example.invalid>',
  'Date: Sun, 01 Sep 2024 00:30:00 +0530', `Message-ID: ${id}`, `Subject: ${subject}`,
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="boundary123"', '',
  '--boundary123','Content-Type: text/plain; charset=utf-8','',
  'Water ingress in the bedroom.\r\n<script>alert(1)</script> [x](https://example.invalid)',
  '--boundary123','Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="../../CON.exe"','Content-Transfer-Encoding: base64','',
  'AAECA/8=', '--boundary123--', '',
].join('\r\n'));

class MockImap implements MailTransport {
  path = ''; static validity = '99'; static data = new Map<string, Map<number, Buffer>>();
  static failOnce = false; static fetches = 0;
  static dates = new Map<string,string>();
  static searches: { path: string; since: string }[] = [];
  static downloaded: string[] = [];
  async connect() {} async close() {}
  async folders() { return [...MockImap.data.keys()].map(path => ({path,specialUse:null})); }
  async select(path: string) { this.path = path; return MockImap.validity; }
  async uids(since: Date) { MockImap.searches.push({path:this.path,since:since.toISOString()}); return [...MockImap.data.get(this.path)!.keys()]; }
  async fetch(uid: number, _maxBytes: number, since: Date): Promise<Retrieval> {
    const key=`${this.path}:${uid}`, internalDate=MockImap.dates.get(key) ?? '2024-09-02T10:00:00.000Z';
    if (new Date(internalDate)<since) return {excluded:true};
    MockImap.fetches++;
    if (uid === 2 && MockImap.failOnce) { MockImap.failOnce = false; throw new Error('secret server error password'); }
    const source = MockImap.data.get(this.path)?.get(uid);
    if(source) MockImap.downloaded.push(key);
    return source ? { source, internalDate, internalDateRaw:internalDate } : null;
  }
}
function reset() { MockImap.validity='99'; MockImap.failOnce=false; MockImap.fetches=0; MockImap.dates=new Map(); MockImap.searches=[]; MockImap.downloaded=[]; MockImap.data=new Map([['INBOX',new Map([[1,raw()],[2,raw('Repair notice')]])],['Sent',new Map([[8,raw()]])]]); }
const quiet = () => {};

describe('local archive checkpoint', () => {
  test('Bun Windows dependency smoke: SQLite FTS5, MailParser and ImapFlow load', async () => {
    const { c,index } = await setup();
    expect(new YahooImap(c)).toBeInstanceOf(YahooImap);
    expect((await parse(raw())).attachments[0]?.bytes).toEqual(Buffer.from([0,1,2,3,255]));
    expect(index.db.query("SELECT sqlite_version() version").get()).toBeTruthy();
  });
  test('byte-exact originals, timezone, attachment hashes, FTS and folder copies', async () => {
    reset(); const { c,index,root } = await setup();
    const s=await sync(c,index,()=>new MockImap(),{},quiet);
    expect(s.archived).toBe(3); expect(index.all()).toHaveLength(2);
    const m=index.search({query:'water ingress'})[0]!;
    expect(m.date_raw).toContain('+0530'); expect(m.date_utc).toBe('2024-08-31T19:00:00.000Z');
    expect(index.sources(m.id)).toHaveLength(2);
    expect(await readVerified(root,m.path,m.sha256)).toEqual(raw());
    expect(index.attachments(m.id)[0]?.filename).toBe('../../CON.exe');
    expect(await verifyArchive(root,index)).toBe(2);
    expect(index.search({address:'LANDLORD@example.invalid',subject:'water',since:'2024-08-31T00:00:00.000Z',until:'2024-09-01T00:00:00.000Z'})).toHaveLength(1);
  });
  test('resume skips successes, backfills holes, tolerates duplicate Message-IDs and UIDVALIDITY changes', async () => {
    reset(); MockImap.failOnce=true; const {c,index}=await setup(); const events:string[]=[];
    await sync(c,index,()=>new MockImap(),{retryDelay:0},e=>events.push(e));
    expect(events).toContain('retry'); expect(events.join(' ')).not.toContain('password');
    const fetches=MockImap.fetches;
    await sync(c,index,()=>new MockImap(),{},quiet); expect(MockImap.fetches).toBe(fetches);
    MockImap.data.get('INBOX')!.set(5,raw('New correspondence'));
    await sync(c,index,()=>new MockImap(),{},quiet); expect(index.all()).toHaveLength(3);
    MockImap.validity='100'; MockImap.data.get('INBOX')!.set(1,raw('Different UID content'));
    await sync(c,index,()=>new MockImap(),{},quiet);
    expect(index.all()).toHaveLength(4);
    expect((index.db.query('SELECT count(*) n FROM occurrences').get() as {n:number}).n).toBe(8);
  });
  test('dry-run does not archive; earlier backfill requires confirmation after a later sync', async () => {
    reset(); const {c,index}=await setup();
    expect((await sync(c,index,()=>new MockImap(),{dryRun:true},quiet)).pending).toBe(3);
    expect(index.all()).toHaveLength(0);
    await sync(c,index,()=>new MockImap(),{since:new Date('2025-01-01')},quiet);
    expect(index.all()).toHaveLength(0);
    await expect(sync(c,index,()=>new MockImap(),{},quiet)).rejects.toThrow('EARLIER_SYNC_CONFIRMATION_REQUIRED');
    await sync(c,index,()=>new MockImap(),{confirmEarlier:async()=>true},quiet); expect(index.all()).toHaveLength(2);
  });
  test('default boundary applies to Inbox, Sent and custom folders, before any old body download',async()=> {
    reset(); const {c,index}=await setup();
    MockImap.data.set('Custom',new Map([[10,raw('Old Date header, new arrival')],[11,raw('Old message')]]));
    for (const path of ['INBOX','Sent','Custom']) {
      MockImap.data.get(path)!.set(11,raw('Old message'));
      MockImap.dates.set(`${path}:11`,'2024-08-31T23:59:59.999Z');
    }
    MockImap.dates.set('INBOX:1','2024-09-01T00:00:00.000Z');
    const result=await sync(c,index,()=>new MockImap(),{},quiet);
    expect(c.archiveSince).toBe('2024-09-01T00:00:00.000Z');
    expect(result.excluded).toBe(3); expect(result.archived).toBe(4);
    expect(MockImap.searches).toEqual(['INBOX','Sent','Custom'].map(path=>({path,since:c.archiveSince})));
    expect(MockImap.downloaded.some(key=>key.endsWith(':11'))).toBe(false);
    expect(index.all().some(m=>m.subject==='Old message')).toBe(false);
    // Sender Date can predate the boundary: only INTERNALDATE controls acquisition.
    expect(index.all().find(m=>m.subject==='Old Date header, new arrival')?.date_utc).toBe('2024-08-31T19:00:00.000Z');
    MockImap.data.get('Sent')!.set(12,raw('New Sent reply'));
    await sync(c,index,()=>new MockImap(),{},quiet);
    expect(index.all().some(m=>m.subject==='New Sent reply')).toBe(true);
    expect(MockImap.downloaded.filter(key=>key==='INBOX:1')).toHaveLength(1);
  });
  test('earlier CLI and environment boundaries fail closed before account access, including dry-run',async()=> {
    reset(); const {c,index}=await setup(); let connections=0;
    const factory=()=>{connections++;return new MockImap();};
    await expect(sync(c,index,factory,{since:new Date('2024-08-01')},quiet)).rejects.toThrow('EARLIER_SYNC_CONFIRMATION_REQUIRED');
    await expect(sync(c,index,factory,{since:new Date('2024-08-01'),dryRun:true,confirmEarlier:async()=>false},quiet)).rejects.toThrow('EARLIER_SYNC_CONFIRMATION_REQUIRED');
    await expect(sync({...c,archiveSince:'2024-08-01T00:00:00.000Z'},index,factory,{},quiet)).rejects.toThrow('EARLIER_SYNC_CONFIRMATION_REQUIRED');
    expect(connections).toBe(0); expect(index.syncBoundary(c.accountId)).toBeNull();
    MockImap.dates.set('INBOX:1','2024-08-15T00:00:00.000Z');
    await sync(c,index,factory,{since:new Date('2024-08-01'),confirmEarlier:async change=>{
      expect(change).toEqual({requested:'2024-08-01T00:00:00.000Z',guarded:'2024-09-01T00:00:00.000Z'});return true;
    }},quiet);
    expect(MockImap.downloaded).toContain('INBOX:1');
  });
  test('configured later boundary is enforced, config rollback requires confirmation, dry-run does not alter policy',async()=> {
    reset(); const {c,index}=await setup();
    const later={...c,archiveSince:'2024-10-01T00:00:00.000Z'};
    const preview=await sync(later,index,()=>new MockImap(),{dryRun:true},quiet);
    expect(preview.pending).toBe(3); expect(index.syncBoundary(c.accountId)).toBeNull();
    await sync(later,index,()=>new MockImap(),{},quiet);
    expect(MockImap.downloaded).toHaveLength(0);
    expect(index.syncBoundary(c.accountId)).toBe(later.archiveSince);
    await expect(sync(c,index,()=>new MockImap(),{},quiet)).rejects.toThrow('EARLIER_SYNC_CONFIRMATION_REQUIRED');
    await sync(c,index,()=>new MockImap(),{confirmEarlier:async()=>true},quiet);
    expect(index.all()).toHaveLength(2);
  });
  test('moving boundary forward retains previously archived out-of-range evidence',async()=> {
    reset(); const {c,index,root}=await setup();
    const m=await parse(raw('Previously archived August evidence'));
    await writeOnce(root,m.path,raw('Previously archived August evidence'));
    const b=index.mailbox({id:c.accountId,host:c.host,port:c.port,login:c.user},'INBOX','99');
    index.record(b,'99',50,'2024-08-01T00:00:00.000Z','old internal date',m);
    await sync(c,index,()=>new MockImap(),{},quiet);
    const saved=index.all().find(row=>row.sha256===m.sha256)!;
    expect(saved).toBeTruthy(); expect(index.sources(saved.id)[0]?.uid).toBe(50);
    expect(await readVerified(root,saved.path,saved.sha256)).toEqual(raw('Previously archived August evidence'));
  });
  test('invalid configured dates and non-midnight/invalid API dates never become unbounded searches',async()=> {
    expect(()=>config({MAIL_ARCHIVE_SINCE:'2024-02-30'})).toThrow('INVALID_DATE');
    expect(()=>config({MAIL_ARCHIVE_SINCE:''})).toThrow('INVALID_DATE');
    expect(config({MAIL_ARCHIVE_SINCE:'2024-10-01'}).archiveSince).toBe('2024-10-01T00:00:00.000Z');
    const {c,index}=await setup(); let called=false;
    for (const since of [new Date('invalid'),new Date('2024-09-01T12:00:00.000Z')]) {
      await expect(sync(c,index,()=>{called=true;return new MockImap();},{since},quiet)).rejects.toThrow('INVALID_SYNC_BOUNDARY');
    }
    expect(called).toBe(false);
  });
  test('schema v1 migrates boundary policy without changing existing evidence',async()=> {
    const {c,index,root}=await setup(); const m=await parse(raw());
    const b=index.mailbox({id:c.accountId,host:c.host,port:c.port,login:c.user},'INBOX','99');
    index.record(b,'99',1,'2024-08-01T00:00:00.000Z','old date',m);
    index.db.exec('DROP TABLE sync_boundaries; PRAGMA user_version=1;');
    index.close(); databases.splice(databases.indexOf(index),1);
    const migrated=new Index(root); databases.push(migrated);
    expect(migrated.all()[0]?.sha256).toBe(m.sha256); expect(migrated.sources(1)[0]?.internal_date).toBe('2024-08-01T00:00:00.000Z');
    expect(migrated.syncBoundary(c.accountId)).toBeNull();
    expect((migrated.db.query('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(2);
  });
  test('filesystem failure cannot commit a successful occurrence', async () => {
    reset(); const {c,index,root}=await setup();
    const m=await parse(raw()); await mkdir(join(root,'objects',m.sha256.slice(0,2)),{recursive:true});
    await writeFile(join(root,m.path),'corrupt');
    const result=await sync(c,index,()=>new MockImap(),{},quiet);
    expect(result.failed).toBe(2); expect(index.all()).toHaveLength(0);
  });
  test('explicit export contains originals, inert text, complete manifest and safe paths', async () => {
    reset(); const {c,index,root}=await setup(); await sync(c,index,()=>new MockImap(),{},quiet);
    const id=index.all()[0]!.id;
    await expect(exportCollection(root,index,'beaconsfield',[])).rejects.toThrow('EXPLICIT_SELECTION_REQUIRED');
    const path=await exportCollection(root,index,'beaconsfield',[id]);
    const manifest=await verifyCollection(path);
    expect(manifest.selection).toEqual([id]); expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.sources).toHaveLength(2);
    expect(await readFile(join(path,manifest.entries[0]!.original))).toEqual(raw());
    const md=await readFile(join(path,manifest.entries[0]!.document),'utf8');
    expect(md).toContain('    <script>');
    expect(manifest.files.every(f=>!f.path.includes('CON.exe'))).toBe(true);
    const file=join(path,manifest.entries[0]!.document); await chmod(file,0o600); await writeFile(file,'tampered');
    await expect(verifyCollection(path)).rejects.toThrow('OBJECT_HASH_MISMATCH');
  });
  test('write-once objects, traversal rejection, exclusive lock, invalid dates and SQL injection', async () => {
    const {root,index}=await setup();
    await writeOnce(root,'objects/test',Buffer.from('original'));
    await expect(writeOnce(root,'objects/test',Buffer.from('changed'))).rejects.toThrow('OBJECT_HASH_MISMATCH');
    expect(()=>inside(root,'../../escape')).toThrow(); expect(()=>caseName('CON')).toThrow();
    await withWriter(root,async()=> { await expect(withWriter(root,async()=>{})).rejects.toThrow('ARCHIVE_LOCKED'); });
    expect(()=>utc('2024-02-30')).toThrow(); expect(()=>utc('2024-02-29')).not.toThrow();
    expect(index.search({query:'" OR 1=1 --'})).toHaveLength(0);
    await expect(main(['export','--case','example'])).rejects.toThrow('EXPLICIT_SELECTION_REQUIRED');
  });
  test('failed transaction leaves no partial message or FTS row',async()=> {
    const {index}=await setup(); const parsed=await parse(raw());
    const b=index.mailbox({id:'test',host:'test',port:993,login:'synthetic'},'INBOX','1');
    // Attachment positions conflict only through a UID collision after all insertion work.
    index.record(b,'1',1,'2024-09-02T10:00:00.000Z','synthetic',parsed);
    const other=await parse(raw('different bytes'));
    expect(()=>index.record(b,'1',1,'2024-09-02T10:00:00.000Z','synthetic',other)).toThrow('UID_CONTENT_CHANGED');
    expect(index.all()).toHaveLength(1); expect(index.search({query:'different bytes'})).toHaveLength(0);
  });
  test('rate limit spaces requests; retries transient failures but not explicit integrity errors',async()=> {
    const rate=new RateLimit(20); await rate.wait(); const start=Date.now(); await rate.wait();
    expect(Date.now()-start).toBeGreaterThanOrEqual(15);
    let tries=0;
    await retry(async()=>{if(++tries<3)throw new Error('synthetic');},3,quiet,0); expect(tries).toBe(3);
    tries=0;
    await expect(retry(async()=>{tries++;throw new AppError('OBJECT_HASH_MISMATCH');},3,quiet,0)).rejects.toThrow('OBJECT_HASH_MISMATCH');
    expect(tries).toBe(1);
  });
});
