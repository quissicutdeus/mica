// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from '../Database';
import { hostedUrlPrefixes, prefixPatterns, storedBytesSql } from './quota';

interface MediaTotalsRow {
  rowCount: number | string | null;
  totalBytes: number | string | null;
}

interface MediaHolderRow {
  citizenid: string;
  rowCount: number | string;
  bytes: number | string | null;
}

export interface MediaStorageStats {
  rowCount: number;
  totalBytes: number;
  topHolders: { citizenid: string; rowCount: number; bytes: number }[];
}

const TOP_HOLDER_COUNT = 10;

/**
 * MICA-71 step 1: measure before anything else. The size lives in `data` and `thumbnail`
 * themselves, measured directly — and, for a hosted row, in `byte_size` or the nominal size
 * (MICA-293), since its bytes are on the image host rather than in the row. The same
 * expression the quota charges, so the report and the ceiling agree. Every row counts, not
 * just `status = 'active'` ones: a soft delete leaves the payload columns in place, so a
 * deleted or moderated row still costs exactly as many bytes as a live one until something
 * actually purges it.
 */
export const mediaStorageStats = async (): Promise<MediaStorageStats> => {
  const prefixes = await hostedUrlPrefixes();
  const cost = storedBytesSql(prefixes.length);
  const patterns = prefixPatterns(prefixes);

  const totals = await Database.single<MediaTotalsRow>(
    `SELECT COUNT(*) AS rowCount,
            SUM(${cost}) AS totalBytes
     FROM mica_media`,
    patterns
  );

  const holders = await Database.query<MediaHolderRow[]>(
    `SELECT citizenid,
            COUNT(*) AS rowCount,
            SUM(${cost}) AS bytes
     FROM mica_media
     GROUP BY citizenid
     ORDER BY bytes DESC
     LIMIT ${TOP_HOLDER_COUNT}`,
    patterns
  );

  return {
    rowCount: Number(totals?.rowCount ?? 0),
    totalBytes: Number(totals?.totalBytes ?? 0),
    topHolders: (holders ?? []).map((h) => ({
      citizenid: h.citizenid,
      rowCount: Number(h.rowCount),
      bytes: Number(h.bytes ?? 0)
    }))
  };
};

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
};
