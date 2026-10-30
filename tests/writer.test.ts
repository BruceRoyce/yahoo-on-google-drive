import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWriter } from '../src/core';

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const moduleUrl = new URL('../src/core.ts', import.meta.url).href;
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'archive-lock-test-')); roots.push(path); return path;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

test('writer lock excludes another process and recovers automatically after process termination', async () => {
  const path = await root();
  const script = `import { withWriter } from ${JSON.stringify(moduleUrl)};
    await withWriter(${JSON.stringify(path)},async()=>{
      process.stdout.write('locked');
      await new Promise(()=>{setInterval(()=>{},1000);});
    });`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  const output = await child.stdout.getReader().read();
  expect(new TextDecoder().decode(output.value)).toBe('locked');
  await expect(withWriter(path, async () => {})).rejects.toThrow('ARCHIVE_LOCKED');
  child.kill(); await child.exited;
  await withWriter(path, async () => {});
  // Persistent lock-file existence must not block a later writer.
  expect((await stat(join(path,'.writer.sqlite'))).isFile()).toBe(true);
  await withWriter(path, async () => {});
}, 10000);

test('legacy dead-process marker is retired without changing evidence', async () => {
  const path = await root();
  const child = Bun.spawn([process.execPath,'--eval','process.exit(0)'],{stdout:'ignore',stderr:'ignore'});
  await child.exited;
  await writeFile(join(path,'.writer.lock'),JSON.stringify({pid:child.pid,created:new Date().toISOString()}));
  await writeFile(join(path,'evidence.eml'),'synthetic preserved bytes');
  await withWriter(path,async()=>{});
  await expect(stat(join(path,'.writer.lock'))).rejects.toHaveProperty('code','ENOENT');
  expect(await readFile(join(path,'evidence.eml'),'utf8')).toBe('synthetic preserved bytes');
});

test('legacy live-process marker remains intact and never permits another writer',async()=> {
  const path=await root(); const marker=JSON.stringify({pid:process.pid});
  await writeFile(join(path,'.writer.lock'),marker);
  await expect(withWriter(path,async()=>{})).rejects.toThrow('ARCHIVE_LOCKED');
  expect(await readFile(join(path,'.writer.lock'),'utf8')).toBe(marker);
});

test('malformed legacy marker is preserved and reported separately',async()=> {
  const path=await root();
  await writeFile(join(path,'.writer.lock'),'incomplete');
  await expect(withWriter(path,async()=>{})).rejects.toThrow('LEGACY_LOCK_INVALID');
  expect(await readFile(join(path,'.writer.lock'),'utf8')).toBe('incomplete');
});

test('lock filesystem failures are not reported as an active writer',async()=> {
  const path=await root(); await mkdir(join(path,'.writer.sqlite'));
  await expect(withWriter(path,async()=>{})).rejects.toThrow('ARCHIVE_LOCK_IO_ERROR');
});

test('action failure releases the OS lock',async()=> {
  const path=await root();
  await expect(withWriter(path,async()=>{throw new Error('synthetic failure');})).rejects.toThrow('synthetic failure');
  await withWriter(path,async()=>{});
});
