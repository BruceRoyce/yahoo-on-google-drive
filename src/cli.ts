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
export { utc } from './dates';

const help = `Local Yahoo evidence archive (no web server)
  bun mail:folders
  bun mail:sync [--folder INBOX --folder Sent] [--since YYYY-MM-DD] [--dry-run]
  bun mail:search [--query TEXT] [--address EMAIL] [--subject TEXT]
                  [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit 100] [--offset 0]
  bun mail:export --case NAME --ids 1,2,3
  bun mail:verify
  bun mail:drive-connect
  bun mail:drive-folder --name NAME
  bun mail:drive-upload --case NAME --collection COLLECTION [--dry-run]
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
    collection: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } });
  const allowed: Record<string, string[]> = {
    folders: [], sync: ['folder','since','dry-run'], search: ['query','address','subject','since','until','limit','offset'],
    export: ['case','ids'], verify: [], 'drive-connect': [], 'drive-folder': ['name'], 'drive-upload': ['case','collection','dry-run'],
  };
  if (!allowed[command]) throw new AppError('UNKNOWN_COMMAND');
  for (const key of Object.keys(v)) if (key !== 'dry-run' && !allowed[command]!.includes(key)) throw new AppError('OPTION_NOT_SUPPORTED');
  if (v['dry-run'] && !allowed[command]!.includes('dry-run')) throw new AppError('OPTION_NOT_SUPPORTED');
  const c = config(process.env, command === 'folders' || command === 'sync');
  const since = utc(v.since), until = utc(v.until);
  if (since && until && since >= until) throw new AppError('INVALID_DATE_RANGE');
  if (command==='export') {
    if (!v.case || !v.ids || !/^\d+(,\d+)*$/.test(v.ids)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
    caseName(v.case);
    if (v.ids.split(',').some(id=>!Number.isSafeInteger(Number(id)) || Number(id)<=0)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
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
        if (!await confirmation(`CREATE ${v.name}`,`Create a new private Drive folder named ${JSON.stringify(v.name)}.`)) throw new AppError('FOLDER_NOT_CONFIRMED');
        const drive=new GoogleDrive(c.root,oauthConfig());
        const id=await retry(()=>drive.reserve(),c.attempts,log);
        await retry(()=>drive.folder(id,v.name!,null,{archiveApp:'yahoo-evidence-archive'}),c.attempts,log);
        console.log(`Set GOOGLE_DRIVE_FOLDER_ID=${id} in your local .env`);
      } else {
        if (!v.case || !v.collection) throw new AppError('EXPLICIT_COLLECTION_REQUIRED');
        const parent=driveId(process.env.GOOGLE_DRIVE_FOLDER_ID ?? '');
        await uploadCollection(c.root,{case:v.case,collection:v.collection,parent,dryRun:v['dry-run']},()=>new GoogleDrive(c.root,oauthConfig()),
          summary=>confirmation(`UPLOAD ${v.case} ${v.collection} TO ${parent}`,
            `Upload ${summary.messages} selected messages (${summary.files} files, ${summary.bytes} bytes) to Drive folder ${parent}. The collection includes original messages, attachments, and metadata.`),log);
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
        console.log(JSON.stringify(index.search(s).map(m => ({ id: m.id, subject: m.subject, from: m.sender, to: m.recipients, date: m.date_utc, sha256: m.sha256, sources: index.sources(m.id) })),null,2));
      } else if (command === 'export') {
        if (!v.case || !v.ids || !/^\d+(,\d+)*$/.test(v.ids)) throw new AppError('EXPLICIT_SELECTION_REQUIRED');
        console.log(await exportCollection(c.root,index,v.case,v.ids.split(',').map(Number)));
      } else if (command === 'verify') log('archive_verified', { messages: await verifyArchive(c.root,index) });
    } finally { index.close(); }
  });
}
async function confirmation(phrase:string,description:string):Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('INTERACTIVE_CONFIRMATION_REQUIRED');
  console.log(description);
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  try { return await terminal.question(`Type exactly: ${phrase}\n> `)===phrase; } finally { terminal.close(); }
}
if (import.meta.main) main().catch(e => { log(e instanceof AppError ? e.code : 'OPERATION_FAILED'); process.exitCode = 1; });
