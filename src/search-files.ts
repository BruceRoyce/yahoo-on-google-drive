import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError, writeOnce } from './core';

// A filename stem, never a path. Keep saved searches in the local searches folder.
export async function saveSearch(name: string, results: unknown[], cwd = process.cwd(), now = new Date()): Promise<string> {
  const stem = name.replace(/\.json$/i, '');
  if (!stem || stem.length > 100 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(stem) || /[. ]$/.test(stem) || stem === '.' || stem === '..') {
    throw new AppError('INVALID_SEARCH_OUTPUT_NAME');
  }
  const stamp = now.toISOString().replace('T', '__').replace(/[-:]/g, '_').replace(/\.\d{3}Z$/, '');
  const filename = `${stem}_${stamp}.json`;
  const root = resolve(cwd, 'searches');
  await writeOnce(root, filename, Buffer.from(JSON.stringify(results, null, 2) + '\n'));
  return resolve(root, filename);
}

export async function searchFileIds(path: string): Promise<number[]> {
  let rows: unknown;
  try { rows = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new AppError('SEARCH_JSON_READ_FAILED'); }
  if (!Array.isArray(rows) || !rows.length || rows.some(row =>
    typeof row !== 'object' || row === null || !('id' in row) ||
    typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0)) {
    throw new AppError('INVALID_SEARCH_JSON');
  }
  return [...new Set(rows.map(row => (row as { id: number }).id))];
}
