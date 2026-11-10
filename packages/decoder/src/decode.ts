import { unzlibSync } from 'fflate';
import {
  FormatError,
  adler32,
  base64ToBytes,
  cipher,
  cipherState,
  deriveKey,
  looksLikeZlib,
  parseContainer,
  zlibTrailer,
} from './format.ts';
import { parseGuide, type Guide } from './guide.ts';

export interface DecodeOptions {
  /** The BattleTag the export was sold to, e.g. "Name#1234". */
  battleTag: string;
  /** Upper bound on inflated bytes across all blocks. Default 64 MiB. */
  maxExpandedBytes?: number;
}

export interface BlockReport {
  index: number;
  compressedBytes: number;
  expandedBytes: number;
  checksum: number;
}

export interface DecodeResult {
  declaredCount: number;
  formatVersion: number;
  blocks: BlockReport[];
  guides: Guide[];
  /** All inflated blocks concatenated, NUL separators included. */
  payload: Uint8Array;
  payloadSha256: string;
  sourceSha256: string;
}

const DEFAULT_MAX = 64 * 1024 * 1024;

/**
 * Decode one export. Throws FormatError on any structural or integrity
 * failure; a wrong BattleTag surfaces as code "wrong-tag".
 */
export async function decodeExport(
  source: Uint8Array | string,
  options: DecodeOptions,
): Promise<DecodeResult> {
  const sourceBytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source);
  const max = options.maxExpandedBytes ?? DEFAULT_MAX;

  const container = parseContainer(text);
  const state = cipherState(deriveKey(options.battleTag));

  const chunks: Uint8Array[] = [];
  const blocks: BlockReport[] = [];
  let expanded = 0;

  for (let b = 0; b < container.blocks.length; b++) {
    const block = container.blocks[b];
    if (block.mode !== ':') {
      throw new FormatError(
        'unknown-mode',
        `Block ${b + 1} uses payload mode "${block.mode}", which this decoder doesn't support.`,
      );
    }

    const compressed = cipher(base64ToBytes(block.base64), state);

    if (!looksLikeZlib(compressed) || zlibTrailer(compressed) !== block.checksum) {
      throw new FormatError(
        'wrong-tag',
        "This export doesn't open with that BattleTag. Check the tag it was sold to, or the file may be damaged.",
      );
    }

    let inflated: Uint8Array;
    try {
      inflated = unzlibSync(compressed);
    } catch {
      throw new FormatError('inflate-failed', `Block ${b + 1} is damaged and could not be inflated.`);
    }

    expanded += inflated.length;
    if (expanded > max) {
      throw new FormatError(
        'too-large',
        `Decoded data exceeds ${Math.round(max / 1048576)} MiB. Raise the limit if you trust this export.`,
      );
    }
    if (adler32(inflated) !== block.checksum) {
      throw new FormatError(
        'checksum-mismatch',
        `Block ${b + 1} inflated, but its checksum doesn't match. The file may be damaged.`,
      );
    }

    chunks.push(inflated);
    blocks.push({
      index: b + 1,
      compressedBytes: compressed.length,
      expandedBytes: inflated.length,
      checksum: block.checksum,
    });
  }

  const payload = concat(chunks);
  const guides: Guide[] = [];
  for (const record of splitNul(payload)) {
    try {
      guides.push(parseGuide(record, guides.length + 1));
    } catch {
      throw new FormatError('not-utf8', `Guide ${guides.length + 1} is not valid UTF-8 text.`);
    }
  }

  if (guides.length !== container.declaredCount) {
    throw new FormatError(
      'count-mismatch',
      `The export declares ${container.declaredCount} guides but ${guides.length} were found.`,
    );
  }

  return {
    declaredCount: container.declaredCount,
    formatVersion: container.formatVersion,
    blocks,
    guides,
    payload,
    payloadSha256: await sha256Hex(payload),
    sourceSha256: await sha256Hex(sourceBytes),
  };
}

function* splitNul(data: Uint8Array): Generator<Uint8Array> {
  let start = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i === data.length || data[i] === 0) {
      if (i > start) yield data.subarray(start, i);
      start = i + 1;
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
