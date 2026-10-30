import { AppError } from './core';

export const DEFAULT_ARCHIVE_SINCE = '2024-09-01';

export function utc(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('INVALID_DATE');
  const date = new Date(value+'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new AppError('INVALID_DATE');
  return date.toISOString();
}

export function boundaryDate(date: Date): string {
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(11) !== '00:00:00.000Z') throw new AppError('INVALID_SYNC_BOUNDARY');
  return date.toISOString();
}
