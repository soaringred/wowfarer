/**
 * The RestedXP export container, as the public RXPGuides addon reads it.
 *
 * Reference: RXPGuides/GuideLoader.lua (CheckDataIntegrity, ReadCacheData,
 * LoadImportBuffer), https://github.com/RestedXP/RXPGuides, which is
 * published under CC BY-NC-SA 4.0. This file contains no code from it; it
 * implements the same byte-level format so that an export can be read
 * outside the game by the person it was sold to.
 *
 * Shape of a file:
 *
 *   <guide count>|<checksum>:<base64>%[<checksum>:<base64>%...]|<format marker>
 *
 * Each base64 block, once decoded, is a stream cipher over a zlib stream.
 * The cipher key is derived from the buyer's BattleTag. The checksum is the
 * Adler-32 of the inflated text, which is also the zlib trailer.
 */

export class FormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FormatError';
    this.code = code;
  }
}

export interface RawBlock {
  /** Declared Adler-32, already reduced to an unsigned 32-bit value. */
  checksum: number;
  /** Single character between the checksum and the payload. Only ':' is known. */
  mode: string;
  base64: string;
}

export interface Container {
  declaredCount: number;
  formatVersion: number;
  blocks: RawBlock[];
}

const CONTAINER = /^(\d{1,9})\|([\s\S]+)\|(\d{1,10})$/;
const BLOCK = /(-?\d{1,10})([^0-9])([A-Za-z0-9+/=]+)%/y;

/** Split the outer container into its declared count, blocks and marker. */
export function parseContainer(text: string): Container {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  body = body.replace(/^[\s]+|[\s]+$/g, '');

  const outer = CONTAINER.exec(body);
  if (!outer) {
    throw new FormatError(
      'not-an-export',
      "This doesn't look like a guide export. Expected <count>|<data>|<marker>.",
    );
  }
  const declaredCount = Number(outer[1]);
  const formatVersion = Number(outer[3]);
  if (declaredCount < 1) {
    throw new FormatError('empty', 'The export declares zero guides.');
  }

  const inner = outer[2];
  const blocks: RawBlock[] = [];
  let at = 0;
  while (at < inner.length) {
    BLOCK.lastIndex = at;
    const m = BLOCK.exec(inner);
    if (!m) {
      throw new FormatError(
        'malformed-block',
        `Unreadable data at offset ${at}. The file may be truncated.`,
      );
    }
    blocks.push({
      checksum: toUint32(Number(m[1])),
      mode: m[2],
      base64: m[3],
    });
    at = BLOCK.lastIndex;
  }
  return { declaredCount, formatVersion, blocks };
}

/** Lua's `%  4294967296` on a possibly negative integer. */
export function toUint32(n: number): number {
  return ((n % 4294967296) + 4294967296) % 4294967296;
}

/** Strict standard Base64 with padding. */
export function base64ToBytes(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new FormatError('bad-base64', 'Payload is not valid Base64.');
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derive the 16-byte key the addon builds from a BattleTag.
 *
 * Lowercase the tag as ASCII bytes, keep the last 16 bytes, right-align them
 * in a 16-byte buffer, then run one pass of a fixed XOR recurrence that
 * updates the buffer in place.
 */
export function deriveKey(battleTag: string): Uint8Array {
  const raw = new TextEncoder().encode(battleTag);
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c >= 0x41 && c <= 0x5a) raw[i] = c | 0x20;
  }
  const tail = raw.subarray(Math.max(0, raw.length - 16));
  const pad = 16 - tail.length;

  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const j = (i - pad) & 0xf;
    key[i] = j < tail.length ? tail[j] : 0;
  }
  for (let i = 0; i < 16; i++) {
    key[-i & 0xf] =
      key[(15 - i) & 0xf] ^ key[(13 - i) & 0xf] ^ key[(12 - i) & 0xf] ^ key[(10 - i) & 0xf];
  }
  return key;
}

/** Key-scheduling: a 256-entry permutation seeded from the 16-byte key. */
export function cipherState(key: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i & 0xf]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  return s;
}

/**
 * Apply the stream cipher. Symmetric, so this both encrypts and decrypts.
 * The state is copied; each block in an export starts from the same state.
 */
export function cipher(data: Uint8Array, initialState: Uint8Array): Uint8Array {
  const s = initialState.slice();
  const out = new Uint8Array(data.length);
  let i = 0;
  let j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/** Adler-32 as used by zlib. */
export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  // Process in chunks small enough that the sums cannot overflow 2^53.
  const CHUNK = 5552;
  for (let off = 0; off < data.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, data.length);
    for (let i = off; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** True if the first two bytes form a plausible zlib header. */
export function looksLikeZlib(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const cmf = data[0];
  const flg = data[1];
  return (cmf & 0x0f) === 8 && cmf <= 0x78 && (flg & 0x20) === 0 && (cmf * 256 + flg) % 31 === 0;
}

/** Read the big-endian trailer of a zlib stream. */
export function zlibTrailer(data: Uint8Array): number {
  const n = data.length;
  return ((data[n - 4] << 24) | (data[n - 3] << 16) | (data[n - 2] << 8) | data[n - 1]) >>> 0;
}
