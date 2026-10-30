import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError, safePath } from './core';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export type Http = (url: string, init?: RequestInit) => Promise<Response>;
export const http: Http = (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120_000) });
export interface OAuthConfig { clientId: string; clientSecret: string }
export interface Tokens { refresh_token: string; access_token: string; expires_at: number; scope: string; client_id: string }
export function oauthConfig(env = process.env): OAuthConfig {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError('GOOGLE_CLIENT_CONFIGURATION_REQUIRED');
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}
export async function privateJson(root: string, path: string, value: unknown): Promise<void> {
  const target=await safePath(root,path);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temp=`${target}.${randomUUID()}.tmp`;
  const file=await open(temp,'wx',0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temp,target);
}
export async function tokenExchange(c: OAuthConfig, parameters: Record<string,string>, request: Http = http): Promise<Record<string,unknown>> {
  const response=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,...parameters}).toString()});
  if (!response.ok) throw new AppError('OAUTH_TOKEN_REQUEST_FAILED');
  return await response.json() as Record<string,unknown>;
}
function checkScope(scope: string): void {
  const scopes=scope.split(' ').filter(Boolean);
  if (!scopes.includes(DRIVE_SCOPE) || scopes.some(s=>s!==DRIVE_SCOPE)) throw new AppError('UNEXPECTED_OAUTH_SCOPE');
}
export function authorization(c: OAuthConfig, redirect: string): { url: string; state: string; verifier: string } {
  const verifier=randomBytes(32).toString('base64url'), state=randomBytes(32).toString('base64url');
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:c.clientId,redirect_uri:redirect,response_type:'code',scope:DRIVE_SCOPE,
    access_type:'offline',prompt:'consent',state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
  return {url:url.toString(),state,verifier};
}
export function callbackCode(url: URL, expectedState: string): string {
  if (url.pathname!=='/callback' || url.searchParams.get('state')!==expectedState || url.searchParams.has('error') || !url.searchParams.get('code')) throw new AppError('OAUTH_CALLBACK_REJECTED');
  return url.searchParams.get('code')!;
}
export async function connectOAuth(root: string, c: OAuthConfig, show: (url:string)=>void, request: Http = http): Promise<void> {
  let accept!: (code:string)=>void, reject!: (e:Error)=>void;
  const received=new Promise<string>((res,rej)=>{accept=res;reject=rej;});
  let expected='';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    const url=new URL(req.url);
    if (req.method!=='GET' || req.headers.has('origin') || url.host!==`127.0.0.1:${server.port}`) return new Response('Rejected',{status:400});
    try { const code=callbackCode(url,expected); accept(code); return new Response('Authorization received. You may close this window.',{headers:{'Content-Type':'text/plain','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"}}); }
    catch { return new Response('Rejected',{status:400}); }
  }});
  const redirect=`http://127.0.0.1:${server.port}/callback`, flow=authorization(c,redirect); expected=flow.state;
  const timer=setTimeout(()=>reject(new AppError('OAUTH_TIMEOUT')),180_000);
  try {
    show(flow.url);
    const code=await received;
    const result=await tokenExchange(c,{grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:flow.verifier},request);
    if (typeof result.refresh_token!=='string' || typeof result.access_token!=='string' || typeof result.expires_in!=='number' || typeof result.scope!=='string') throw new AppError('OAUTH_INCOMPLETE_RESPONSE');
    checkScope(result.scope);
    await privateJson(root,'private/google.token.json',{refresh_token:result.refresh_token,access_token:result.access_token,expires_at:Date.now()+result.expires_in*1000,scope:result.scope,client_id:c.clientId} satisfies Tokens);
  } finally { clearTimeout(timer); await server.stop(true); }
}
export async function accessToken(root: string, c: OAuthConfig, request: Http = http): Promise<string> {
  let tokens: Tokens;
  try { tokens=JSON.parse(await readFile(await safePath(root,'private/google.token.json'),'utf8')) as Tokens; }
  catch { throw new AppError('GOOGLE_CONNECT_REQUIRED'); }
  if (tokens.client_id!==c.clientId || typeof tokens.refresh_token!=='string') throw new AppError('GOOGLE_CONNECT_REQUIRED');
  checkScope(tokens.scope);
  if (tokens.expires_at>Date.now()+60_000 && typeof tokens.access_token==='string') return tokens.access_token;
  const result=await tokenExchange(c,{grant_type:'refresh_token',refresh_token:tokens.refresh_token},request);
  if (typeof result.access_token!=='string' || typeof result.expires_in!=='number') throw new AppError('OAUTH_INCOMPLETE_RESPONSE');
  if (typeof result.scope==='string') checkScope(result.scope);
  tokens.access_token=result.access_token; tokens.expires_at=Date.now()+result.expires_in*1000;
  if (typeof result.refresh_token==='string') tokens.refresh_token=result.refresh_token;
  await privateJson(root,'private/google.token.json',tokens);
  return tokens.access_token;
}
