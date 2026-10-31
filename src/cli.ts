import { parseArgs } from 'node:util';
import { config } from './config';
import { AppError, log, retry, withWriter } from './core';
import { Index, type Search } from './db';
import { YahooImap } from './imap';
import { sync } from './sync';
import { caseName, exportCollection, verifyArchive } from './export';
import { connectOAuth, oauthConfig } from './oauth';
import { GoogleDrive, driveId, uploadCollection } from './drive';
import { createInterface } from 'node:readline/promises';
import { utc } from './dates';
import { saveSearch, searchFileIds } from './search-files';
export { utc } from './dates';

const help = `Local Yahoo evidence archive (no web server)
  bun mail:folders
  bun mail:sync [--folder INBOX --folder Sent] [--since YYYY-MM-DD] [--dry-run]
  bun mail:search [--query TEXT] [--address EMAIL] [--subject TEXT]
                  [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit 100] [--offset 0] [--output NAME]
  bun mail:export --case NAME (--ids 1,2,3 | --json PATH)
  bun mail:verify
  bun mail:drive-connect
  bun mail:drive-folder --name NAME [--yes]
  bun mail:drive-upload --case NAME --collection COLLECTION [--dry-run] [--yes]
Search dates use the RFC Date in UTC; until is exclusive. Sync since uses INTERNALDATE.
Sync defaults to MAIL_ARCHIVE_SINCE=2024-09-01 inclusive; earlier dates require confirmation.
Search output is private message data. Progress/error logs contain no message data.
`;
export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (!command || command === '--help' || args.includes('--help')) { console.log(help); return; }
  const { values: v } = parseArgs({ args: args.slice(1), strict: true, allowPositionals: false, options: {
    folder: { type: 'string', multiple: true }, since: { type: 'string' }, until: { type: 'string' },
    query: { type: 'string' }, address: { type: 'string' }, subject: { type: 'string' },
    limit: { type: 'string' }, offset: { type: 'string' }, ids: { type: 'string' }, case: { type: 'string' },
    output: { type: 'string' }, json: { type: 'string' },
    collection: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean' },
  } });
  const allowed: Record<string, string[]> = {
    folders: [], sync: ['folder','since','dry-run'], search: ['query','address','subject','since','until','limit','offset','output'],
    export: ['case','ids','json'], verify: [], 'drive-connect': [], 'drive-folder': ['name','yes'], 'drive-upload': ['case','collection','dry-run','yes'],
  };
  if (!allowed[command]) throw new AppError('UNKNOWN_COMMAND');
  for (const key of Object.keys(v)) if (key !== 'dry-run' && !allowed[command]!.includes(key)) throw new AppError('OPTION_NOT_SUPPORTED');
  if (v['dry-run'] && !allowed[command]!.includes('dry-run')) throw new AppError('OPTION_NOT_SUPPORTED');
  const c = config(process.env, command === 'folders' || command === 'sync');
  const since = utc(v.since), until = utc(v.until);
  if (since && until && since >= until) throw new AppError('INVALID_DATE_RANGE');
  let exportIds: number[] | undefined;
  if (command==='export') {
    if (!v.case || (v.ids === undefined && v.json === undefined)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
    if (v.ids !== undefined && v.json !== undefined) throw new AppError('SELECTION_OPTIONS_CONFLICT');
    caseName(v.case);
    if (v.ids !== undefined) {
      if (!/^\d+(,\d+)*$/.test(v.ids)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
      exportIds = v.ids.split(',').map(Number);
      if (exportIds.some(id=>!Number.isSafeInteger(id) || id<=0)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
    } else exportIds = await searchFileIds(v.json!);
  }
  if (command === 'folders') {
    const folders = await retry(async () => { const client = new YahooImap(c); try { await client.connect(); return await client.folders(); } finally { await client.close(); } }, c.attempts, log);
    console.log(JSON.stringify(folders,null,2)); return;
  }
  if (command.startsWith('drive-')) {
    await withWriter(c.root,async()=> {
      if (command==='drive-connect') {
        await connectOAuth(c.root,oauthConfig(),url=>console.log(`Open this URL in your system browser within 3 minutes:\n${url}`));
        log('google_connected');
      } else if (command==='drive-folder') {
        if (!v.name || v.name.length>100 || /[\x00-\x1f\x7f]/.test(v.name)) throw new AppError('INVALID_FOLDER_NAME');
        if (!await confirmation(`CREATE ${v.name}`,`Create a new private Drive folder named ${JSON.stringify(v.name)}.`,v.yes)) throw new AppError('FOLDER_NOT_CONFIRMED');
        const drive=new GoogleDrive(c.root,oauthConfig());
        const id=await retry(()=>drive.reserve(),c.attempts,log);
        await retry(()=>drive.folder(id,v.name!,null,{archiveApp:'yahoo-evidence-archive'}),c.attempts,log);
        console.log(`Set GOOGLE_DRIVE_FOLDER_ID=${id} in your local .env`);
      } else {
        if (!v.case || !v.collection) throw new AppError('EXPLICIT_COLLECTION_REQUIRED');
        const parent=driveId(process.env.GOOGLE_DRIVE_FOLDER_ID ?? '');
        await uploadCollection(c.root,{case:v.case,collection:v.collection,parent,dryRun:v['dry-run']},()=>new GoogleDrive(c.root,oauthConfig()),
          summary=>confirmation(`UPLOAD ${v.case} ${v.collection} TO ${parent}`,
            `Upload ${summary.messages} selected messages (${summary.files} files, ${summary.bytes} bytes) to Drive folder ${parent}. The collection includes original messages, attachments, and metadata.`,v.yes),log);
      }
    }); return;
  }
  await withWriter(c.root, async () => {
    const index = new Index(c.root);
    try {
      if (command === 'sync') {
        const result = await sync(c,index,() => new YahooImap(c),{
          ...(v.folder ? { folders: v.folder } : {}), ...(since ? { since: new Date(since) } : {}), dryRun: v['dry-run'],
          confirmEarlier: change => confirmation(`ARCHIVE FROM ${change.requested.slice(0,10)}`,
            `This expands synchronisation earlier than ${change.guarded.slice(0,10)} to ${change.requested.slice(0,10)} (INTERNALDATE, inclusive). Existing evidence will be retained.`),
        },log);
        if (result.failed) throw new AppError('SYNC_INCOMPLETE');
      } else if (command === 'search') {
        const s: Search = { ...(v.query ? { query: v.query } : {}), ...(v.address ? { address: v.address } : {}),
          ...(v.subject ? { subject: v.subject } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}),
          limit: v.limit === undefined ? 100 : Number(v.limit), offset: v.offset === undefined ? 0 : Number(v.offset) };
        const results = index.search(s).map(m => ({ id: m.id, subject: m.subject, from: m.sender, to: m.recipients, date: m.date_utc, sha256: m.sha256, sources: index.sources(m.id) }));
        if (v.output !== undefined) console.log(await saveSearch(v.output, results));
        else console.log(JSON.stringify(results,null,2));
      } else if (command === 'export') {
        console.log(await exportCollection(c.root,index,v.case!,exportIds!));
      } else if (command === 'verify') log('archive_verified', { messages: await verifyArchive(c.root,index) });
    } finally { index.close(); }
  });
}
async function confirmation(phrase:string,description:string,yes=false):Promise<boolean> {
  if (yes) { console.log(description); return true; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('INTERACTIVE_CONFIRMATION_REQUIRED');
  console.log(description);
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  try { return await terminal.question(`Type exactly: ${phrase}\n> `)===phrase; } finally { terminal.close(); }
}
if (import.meta.main) main().catch(e => {
  log(e instanceof AppError ? e.code : 'OPERATION_FAILED');
  if (e instanceof AppError && e.code === 'ARCHIVE_LOCKED') console.error('Another archive command is running, or a legacy lock names a live process. Wait for it to finish.');
  if (e instanceof AppError && e.code === 'ARCHIVE_LOCK_IO_ERROR') console.error('Cannot open the archive writer lock. Check the archive directory permissions and disk availability.');
  if (e instanceof AppError && e.code === 'LEGACY_LOCK_INVALID') console.error('The old .writer.lock marker is invalid. See the README recovery instructions before removing it.');
  process.exitCode = 1;
});
