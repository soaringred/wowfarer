import { sha256Hex, type DecodeResult } from './decode.ts';
import type { Guide } from './guide.ts';

export interface MergeResult {
  guides: Guide[];
  /** Guides dropped because an identical record appeared in an earlier export. */
  duplicates: number;
}

/**
 * Combine guides from several exports, dropping byte-identical records and
 * renumbering so filenames stay unique. Bundles sold separately often
 * overlap (a "hardcore" bundle is usually a subset of an "everything" one).
 */
export async function mergeGuides(results: DecodeResult[]): Promise<MergeResult> {
  const seen = new Set<string>();
  const guides: Guide[] = [];
  let duplicates = 0;
  for (const r of results) {
    for (const g of r.guides) {
      const hash = await sha256Hex(g.bytes);
      if (seen.has(hash)) {
        duplicates++;
        continue;
      }
      seen.add(hash);
      const index = guides.length + 1;
      guides.push({ ...g, index, stem: `${String(index).padStart(3, '0')}${g.stem.slice(3)}` });
    }
  }
  return { guides, duplicates };
}
