import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, writeOnce, hash } from '../src/core';
import { Index } from '../src/db';
import { parse } from '../src/mime';
import { exportCollection } from '../src/export';
import { uploadCollection, GoogleDrive, type DriveService, type RemoteFile } from '../src/drive';
import { accessToken, authorization, callbackCode, connectOAuth, DRIVE_SCOPE, privateJson, type Http } from '../src/oauth';

const roots:string[]=[];
afterEach(async()=> { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
const oauth={clientId:'mock-client',clientSecret:'mock-secret'};
const quiet=()=>{};
async function temp() { const root=await mkdtemp(join(tmpdir(),'drive-test-')); roots.push(root); return root; }
async function collection() {
  const root=await temp(), index=new Index(root);
  try {
    const mailbox=index.mailbox({id:'account',host:'mock',port:993,login:'synthetic'},'INBOX','88');
    for (let uid=1;uid<=2;uid++) {
      const bytes=Buffer.from(`From: synthetic@example.invalid\r\nSubject: ${uid===1?'Selected repairs':'Unrelated private correspondence'}\r\nDate: Mon, 02 Sep 2024 11:00:00 +0100\r\n\r\nSynthetic body ${uid}`);
      const m=await parse(bytes); await writeOnce(root,m.path,bytes);
      index.record(mailbox,'88',uid,'2024-09-02T10:00:00.000Z','mock date',m);
    }
    const path=await exportCollection(root,index,'beaconsfield',[1]); return {root,path,name:basename(path)};
  } finally { index.close(); }
}
class MockDrive implements DriveService {
  next=0; calls=0; fail=false; created=0;
  files=new Map<string,RemoteFile>([['parent123',{id:'parent123',name:'private',mimeType:'application/vnd.google-apps.folder'}]]);
  async reserve() { this.calls++; return `file_${++this.next}`; }
  async get(id:string) { this.calls++; return this.files.get(id)??null; }
  async folder(id:string,name:string,parent:string|null,properties:Record<string,string>) {
    this.calls++;
    if (!this.files.has(id)) this.files.set(id,{id,name,mimeType:'application/vnd.google-apps.folder',parents:parent?[parent]:[],appProperties:properties});
  }
  async upload(id:string,name:string,parent:string,bytes:Buffer,properties:Record<string,string>) {
    this.calls++;
    if (!this.files.has(id)) { this.created++; this.files.set(id,{id,name,mimeType:'application/octet-stream',size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex'),parents:[parent],appProperties:properties}); }
    if (this.fail) { this.fail=false; throw new AppError('SIMULATED_INTERRUPTION'); }
  }
}
test('dry-run and refused confirmation never instantiate cloud services or read tokens',async()=> {
  const {root,name}=await collection(); let factories=0, confirmations=0;
  const factory=()=>{factories++;return new MockDrive();};
  const options={case:'beaconsfield',collection:name,parent:'parent123',dryRun:true};
  await uploadCollection(root,options,factory,async()=>{confirmations++;return true;},quiet,0);
  expect(factories).toBe(0); expect(confirmations).toBe(0);
  await expect(uploadCollection(root,{...options,dryRun:false},factory,async()=>false,quiet,0)).rejects.toThrow('UPLOAD_NOT_CONFIRMED');
  expect(factories).toBe(0);
});
test('selected collection upload resumes after interrupted create without duplicates',async()=> {
  const {root,name}=await collection(), service=new MockDrive();
  const options={case:'beaconsfield',collection:name,parent:'parent123',dryRun:false};
  service.fail=true;
  await expect(uploadCollection(root,options,()=>service,async s=>{expect(s.messages).toBe(1);return true;},quiet,0)).rejects.toThrow('SIMULATED_INTERRUPTION');
  const result=await uploadCollection(root,options,()=>service,async()=>true,quiet,0);
  expect(result.skipped).toBe(1); expect(result.uploaded).toBeGreaterThan(0);
  const count=service.created, reserved=service.next;
  const repeated=await uploadCollection(root,options,()=>service,async()=>true,quiet,0);
  expect(repeated.uploaded).toBe(0); expect(service.created).toBe(count); expect(service.next).toBe(reserved);
  expect([...service.files.values()].some(f=>f.name.includes('2.md'))).toBe(false);
  const remote=[...service.files.values()].find(f=>f.md5Checksum)!; remote.md5Checksum='tampered';
  await expect(uploadCollection(root,options,()=>service,async()=>true,quiet,0)).rejects.toThrow('REMOTE_FILE_MISMATCH');
});
test('tampered local collection fails before confirmation or cloud access',async()=> {
  const {root,path,name}=await collection();
  await chmod(join(path,'index.json'),0o600); await writeFile(join(path,'index.json'),'corrupt');
  let called=false;
  await expect(uploadCollection(root,{case:'beaconsfield',collection:name,parent:'parent123',dryRun:false},()=>{called=true;return new MockDrive();},async()=>{called=true;return true;},quiet,0)).rejects.toThrow('OBJECT_HASH_MISMATCH');
  expect(called).toBe(false);
});
test('OAuth uses PKCE, random state, narrow scope and rejects forged callbacks',()=> {
  const flow=authorization(oauth,'http://127.0.0.1:1234/callback'), u=new URL(flow.url);
  expect(u.searchParams.get('scope')).toBe(DRIVE_SCOPE); expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));
  expect(authorization(oauth,'http://127.0.0.1:1234/callback').state).not.toBe(flow.state);
  expect(()=>callbackCode(new URL('http://127.0.0.1/callback?code=secret&state=forged'),flow.state)).toThrow('OAUTH_CALLBACK_REJECTED');
});
test('OAuth loopback callback exchanges a synthetic code; refresh tokens stay in local private file',async()=> {
  const root=await temp(); let redirect='',pkce='';
  const request:Http=async(url,init)=> {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body=new URLSearchParams(String(init?.body));
    expect(body.get('code')).toBe('synthetic-code'); expect(body.get('redirect_uri')).toBe(redirect);
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(pkce);
    return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:0,scope:DRIVE_SCOPE});
  };
  let callback:Promise<Response>|undefined;
  await connectOAuth(root,oauth,url=> {
    const auth=new URL(url); redirect=auth.searchParams.get('redirect_uri')!; pkce=auth.searchParams.get('code_challenge')!;
    const target=new URL(redirect); target.search=new URLSearchParams({state:auth.searchParams.get('state')!,code:'synthetic-code'}).toString();
    callback=fetch(target);
  },request);
  expect((await callback)!.status).toBe(200);
  let refreshed=0;
  const token=await accessToken(root,oauth,async(url,init)=> {
    refreshed++; expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('synthetic-refresh');
    return Response.json({access_token:'new-access',expires_in:3600});
  });
  expect(token).toBe('new-access'); expect(refreshed).toBe(1);
  expect((JSON.parse(await readFile(join(root,'private/google.token.json'),'utf8')) as {refresh_token:string}).refresh_token).toBe('synthetic-refresh');
});
test('Google Drive HTTP adapter uses OAuth, safe resumable upload and metadata',async()=> {
  const root=await temp(); await privateJson(root,'private/google.token.json',{client_id:oauth.clientId,access_token:'mock-access',refresh_token:'mock-refresh',scope:DRIVE_SCOPE,expires_at:Date.now()+3600000});
  const methods:string[]=[];
  const request:Http=async(url,init)=> {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer mock-access'); methods.push(init?.method??'GET');
    if(url.includes('generateIds')) return Response.json({ids:['reserved123']});
    if(url.includes('uploadType=resumable')) return new Response('',{status:200,headers:{Location:'https://www.googleapis.com/upload/session/mock'}});
    if(url.includes('/upload/session/')) { expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('synthetic'); return Response.json({id:'reserved123'}); }
    if(init?.method==='POST') return Response.json({id:'reserved123'});
    return Response.json({id:'parent123',name:'private',mimeType:'application/vnd.google-apps.folder'});
  };
  const drive=new GoogleDrive(root,oauth,request);
  expect(await drive.reserve()).toBe('reserved123'); expect((await drive.get('parent123'))?.id).toBe('parent123');
  await drive.folder('reserved123','private','parent123',{});
  await drive.upload('reserved123','document','parent123',Buffer.from('synthetic'),{sha256:hash('synthetic')});
  expect(methods).toEqual(['GET','GET','POST','POST','PUT']);
});
test('Drive adapter rejects upload URLs outside Google before leaking tokens or content',async()=> {
  const root=await temp(); await privateJson(root,'private/google.token.json',{client_id:oauth.clientId,access_token:'mock-access',refresh_token:'mock-refresh',scope:DRIVE_SCOPE,expires_at:Date.now()+3600000});
  let calls=0;
  const drive=new GoogleDrive(root,oauth,async()=>{calls++;return new Response('',{headers:{location:'https://attacker.invalid/upload'}});});
  await expect(drive.upload('reserved123','doc','parent123',Buffer.from('synthetic'),{})).rejects.toThrow('UNSAFE_UPLOAD_LOCATION');
  expect(calls).toBe(1);
});
