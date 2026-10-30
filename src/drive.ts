import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, hash, readVerified, safePath, retry, writeOnce, RateLimit, type Log } from './core';
import { verifyCollection, caseName } from './export';
import { accessToken, http, type Http, type OAuthConfig } from './oauth';

export interface RemoteFile { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean; size?: string; md5Checksum?: string; appProperties?: Record<string,string> }
export interface DriveService {
  reserve(): Promise<string>;
  get(id:string): Promise<RemoteFile | null>;
  folder(id:string,name:string,parent:string | null,properties:Record<string,string>): Promise<void>;
  upload(id:string,name:string,parent:string,bytes:Buffer,properties:Record<string,string>): Promise<void>;
}
const base='https://www.googleapis.com/drive/v3/files';
const fields='id,name,mimeType,parents,trashed,size,md5Checksum,appProperties';
export function driveId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{5,200}$/.test(id)) throw new AppError('INVALID_DRIVE_ID'); return id;
}
export class GoogleDrive implements DriveService {
  private readonly rate=new RateLimit(250);
  constructor(private readonly root:string,private readonly oauth:OAuthConfig,private readonly request:Http=http) {}
  private async call(url:string,init:RequestInit={}): Promise<Response> {
    await this.rate.wait();
    const token=await accessToken(this.root,this.oauth,this.request);
    const response=await this.request(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),Authorization:`Bearer ${token}`}});
    if (response.status===429 || response.status>=500) throw new Error('DRIVE_TRANSIENT');
    return response;
  }
  async reserve(): Promise<string> {
    const response=await this.call(`${base}/generateIds?count=1&space=drive&type=files`);
    if (!response.ok) throw new AppError('DRIVE_RESERVE_FAILED');
    const body=await response.json() as {ids?:string[]}; return driveId(body.ids?.[0] ?? '');
  }
  async get(id:string): Promise<RemoteFile|null> {
    const response=await this.call(`${base}/${driveId(id)}?fields=${fields}`);
    if (response.status===404) return null;
    if (!response.ok) throw new AppError('DRIVE_METADATA_FAILED');
    return await response.json() as RemoteFile;
  }
  async folder(id:string,name:string,parent:string|null,properties:Record<string,string>): Promise<void> {
    const response=await this.call(`${base}?fields=id`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:driveId(id),name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[driveId(parent)]}:{}),appProperties:properties})});
    if (!response.ok && response.status!==409) throw new AppError('DRIVE_FOLDER_FAILED');
  }
  async upload(id:string,name:string,parent:string,bytes:Buffer,properties:Record<string,string>): Promise<void> {
    const response=await this.call(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id`,{
      method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(bytes.length)},
      body:JSON.stringify({id:driveId(id),name,parents:[driveId(parent)],appProperties:properties}),
    });
    if (response.status===409) return;
    if (!response.ok) throw new AppError('DRIVE_UPLOAD_START_FAILED');
    const location=response.headers.get('location');
    if (!location) throw new AppError('DRIVE_UPLOAD_LOCATION_MISSING');
    const url=new URL(location);
    if (url.protocol!=='https:' || url.hostname!=='www.googleapis.com' || url.port || url.username || url.password) throw new AppError('UNSAFE_UPLOAD_LOCATION');
    const result=await this.call(url.toString(),{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)},body:new Uint8Array(bytes)});
    if (!result.ok && result.status!==409) throw new AppError('DRIVE_UPLOAD_FAILED');
  }
}

interface Plan { version:1; digest:string; parent:string; folder:string; files:{path:string;id:string;sha256:string;size:number}[] }
export interface UploadOptions { case:string; collection:string; parent:string; dryRun:boolean }
export async function uploadCollection(root:string, options:UploadOptions, factory:()=>DriveService, confirm:(summary:{messages:number;files:number;bytes:number;parent:string;collection:string})=>Promise<boolean>, report:Log, delay=500): Promise<{uploaded:number;skipped:number}> {
  caseName(options.case);
  if (!/^[0-9TZ-]+-[0-9a-f]{8}$/.test(options.collection)) throw new AppError('INVALID_COLLECTION_NAME');
  driveId(options.parent);
  const path=await safePath(root,`collections/${options.case}/${options.collection}`);
  const manifest=await verifyCollection(path);
  if (manifest.case!==options.case || manifest.collection!==options.collection) throw new AppError('COLLECTION_IDENTITY_MISMATCH');
  const manifestBytes=await readFile(await safePath(path,'manifest.json'));
  const digest=hash(manifestBytes);
  const sum=await readFile(await safePath(path,'manifest.sha256'));
  const files=[...manifest.files,{path:'manifest.json',sha256:digest,size:manifestBytes.length},{path:'manifest.sha256',sha256:hash(sum),size:sum.length}];
  const summary={messages:manifest.entries.length,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0),parent:options.parent,collection:options.collection};
  report('drive_plan',{messages:summary.messages,files:summary.files,bytes:summary.bytes});
  if (options.dryRun) return {uploaded:0,skipped:files.length};
  // Even reading OAuth tokens or constructing the cloud service happens only after confirmation.
  if (!await confirm(summary)) throw new AppError('UPLOAD_NOT_CONFIRMED');
  const drive=factory();
  const attempt=<T>(fn:()=>Promise<T>)=>retry(fn,4,report,delay);
  const parent=await attempt(()=>drive.get(options.parent));
  if (!parent || parent.trashed || parent.mimeType!=='application/vnd.google-apps.folder') throw new AppError('DRIVE_DESTINATION_UNAVAILABLE');
  const planPath=`private/uploads/${hash(`${digest}:${options.parent}`)}.json`;
  let plan:Plan;
  try { plan=JSON.parse(await readFile(await safePath(root,planPath),'utf8')) as Plan; }
  catch(e) {
    if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;
    const planned=[];
    for (const f of files) planned.push({...f,id:await attempt(()=>drive.reserve())});
    plan={version:1,digest,parent:options.parent,folder:await attempt(()=>drive.reserve()),files:planned};
    await writeOnce(root,planPath,Buffer.from(JSON.stringify(plan)));
  }
  if (plan.version!==1 || plan.digest!==digest || plan.parent!==options.parent || plan.files.length!==files.length || new Set([plan.folder,...plan.files.map(f=>f.id)]).size!==files.length+1) throw new AppError('UPLOAD_PLAN_MISMATCH');
  for (const f of files) if (!plan.files.some(p=>p.path===f.path && p.sha256===f.sha256 && p.size===f.size)) throw new AppError('UPLOAD_PLAN_MISMATCH');
  const properties={archiveManifest:digest};
  await attempt(()=>drive.folder(plan.folder,`${options.case}-${options.collection}`,options.parent,properties));
  const folder=await attempt(()=>drive.get(plan.folder));
  if (!folder || folder.trashed || folder.mimeType!=='application/vnd.google-apps.folder' || !folder.parents?.includes(options.parent) || folder.appProperties?.archiveManifest!==digest) throw new AppError('REMOTE_FOLDER_MISMATCH');
  const result={uploaded:0,skipped:0};
  for (const f of plan.files) {
    const bytes=await readVerified(path,f.path,f.sha256);
    const name=f.path.replaceAll('/','__');
    const verify=(remote:RemoteFile|null):void=> {
      if (!remote || remote.trashed || remote.name!==name || !remote.parents?.includes(plan.folder) || remote.size!==String(bytes.length) || remote.md5Checksum!==createHash('md5').update(bytes).digest('hex') || remote.appProperties?.sha256!==f.sha256 || remote.appProperties?.archiveManifest!==digest) throw new AppError('REMOTE_FILE_MISMATCH');
    };
    let remote=await attempt(()=>drive.get(f.id));
    if (remote) { verify(remote); result.skipped++; continue; }
    await attempt(()=>drive.upload(f.id,name,plan.folder,bytes,{...properties,sha256:f.sha256}));
    remote=await attempt(()=>drive.get(f.id)); verify(remote); result.uploaded++;
    report('drive_file_verified',{uploaded:result.uploaded,skipped:result.skipped});
  }
  report('drive_complete',result); return result;
}
