import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { saveSearch, searchFileIds } from '../src/search-files';
import { main } from '../src/cli';

test('saved search roundtrip preserves results, deduplicates IDs and uses timestamped Windows filenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'search-test-'));
  try {
    const rows = [{ id: 3, subject: 'Synthetic repair' }, { id: 7 }, { id: 3 }];
    const date = new Date('2026-10-31T01:15:32Z');
    const first = await saveSearch('repairs.json', rows, root, date);
    const second = await saveSearch('repairs', rows, root, date);
    expect(first).toBe(second);
    expect(basename(first)).toBe('repairs_2026_10_31__01_15_32.json');
    await expect(saveSearch('repairs', [{ id: 9 }], root, date)).rejects.toThrow('OBJECT_HASH_MISMATCH');
    expect(JSON.parse(await readFile(first, 'utf8'))).toEqual(rows);
    expect(await searchFileIds(first)).toEqual([3, 7]);
    for (const name of ['../escape', 'folder/file', 'folder\\file', '', 'bad:name']) {
      await expect(saveSearch(name, rows, root)).rejects.toThrow('INVALID_SEARCH_OUTPUT_NAME');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('JSON selection rejects malformed, empty and invalid IDs and conflicting CLI flags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'search-test-'));
  try {
    const file = join(root, 'selection.json');
    for (const content of ['broken', '{}', '[]', '[null]', '[{"id":"1"}]', '[{"id":0}]', '[{"id":1.5}]', '[{"id":9007199254740992}]']) {
      await writeFile(file, content);
      await expect(searchFileIds(file)).rejects.toThrow();
    }
    await expect(searchFileIds(join(root, 'missing.json'))).rejects.toThrow('SEARCH_JSON_READ_FAILED');
    await expect(main(['export', '--case', 'test', '--ids', '1', '--json', file])).rejects.toThrow('SELECTION_OPTIONS_CONFLICT');
  } finally { await rm(root, { recursive: true, force: true }); }
});
