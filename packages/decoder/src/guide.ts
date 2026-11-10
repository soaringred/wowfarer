/**
 * Read the header of a guide in RestedXP's text format.
 *
 * A guide is a header block followed by `step` blocks. Header lines start
 * with `#tag value` or `<< condition`. We only read, never evaluate.
 */

export interface Guide {
  /** 1-based position in the export. */
  index: number;
  name: string;
  group: string;
  /** Every header tag, in order of appearance; repeated tags accumulate. */
  headers: Record<string, string[]>;
  /** Raw `<<` conditions from the header, e.g. "Horde", "Alliance Mage". */
  conditions: string[];
  /** Number of `step` lines, before any condition filtering. */
  stepCount: number;
  /** Exact UTF-8 bytes of the record as exported. */
  bytes: Uint8Array;
  text: string;
  /** Safe filename stem such as "001-23-25-hillsbrad". */
  stem: string;
}

const STEP_LINE = /^[ \t]*step(?=[ \t\r]|$)/;

export function parseGuide(bytes: Uint8Array, index: number): Guide {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const headers: Record<string, string[]> = {};
  const conditions: string[] = [];
  let stepCount = 0;
  let inHeader = true;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trimStart();
    if (STEP_LINE.test(line)) {
      inHeader = false;
      stepCount++;
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith('#')) {
      const m = /^#(\S+)(?:[ \t]+(.*))?$/.exec(line);
      if (m) (headers[m[1]] ??= []).push((m[2] ?? '').trim());
    } else if (line.startsWith('<<')) {
      conditions.push(line.slice(2).trim());
    }
  }

  const name = headers.name?.[0] || `Guide ${index}`;
  const group = headers.group?.[0] ?? '';
  return {
    index,
    name,
    group,
    headers,
    conditions,
    stepCount,
    bytes,
    text,
    stem: `${String(index).padStart(3, '0')}-${slug(name)}`,
  };
}

export function slug(s: string, max = 80): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'guide';
}

/** Pull `Name#1234` from a filename like "Some Title!Name#1234" or "...!Name#1234.txt". */
export function battleTagFromFilename(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const m = /!([^!\r\n#]+#\d+)(?:\.[A-Za-z0-9_-]+)*$/.exec(base);
  return m ? m[1] : null;
}

/** Title portion of an export filename: everything before the first `!`. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const title = base.split('!', 1)[0].replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return title || 'Guides';
}

export function isBattleTag(s: string): boolean {
  return /^[^#\s]+#\d+$/.test(s);
}
