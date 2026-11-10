/**
 * Decodes real exports if any are present. Skipped otherwise, so CI passes
 * without guide content. Put your own exports in ./exports (gitignored) or
 * point WOWFARER_EXPORTS at a folder. Optional expected values are read from
 * an ignored local manifest, never embedded in published test source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeExport } from '../src/decode.ts';
import { battleTagFromFilename } from '../src/guide.ts';

const dir = process.env.WOWFARER_EXPORTS ?? join(import.meta.dirname, '..', '..', '..', 'exports');

type ExpectedExport = { guides: number; bytes: number; sha256: string };
const expectationsPath = process.env.WOWFARER_EXPECTATIONS
  ?? join(import.meta.dirname, '..', '..', '..', '.local', 'export-expectations.json');
let expectations: Record<string, ExpectedExport> = {};
try {
  const manifest = JSON.parse(await readFile(expectationsPath, 'utf8'));
  assert.ok(manifest.bySourceSha256 && typeof manifest.bySourceSha256 === 'object'
    && !Array.isArray(manifest.bySourceSha256), 'expected a bySourceSha256 object');
  expectations = manifest.bySourceSha256;
} catch (error) {
  // A missing default manifest is normal in CI. Explicit paths and malformed
  // manifests must fail so a broken verification setup cannot silently pass.
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.WOWFARER_EXPECTATIONS) throw error;
}

let files: string[] = [];
try {
  files = (await readdir(dir)).filter((f) => battleTagFromFilename(f));
} catch {
  files = [];
}

test('real exports', { skip: files.length === 0 && 'no exports present' }, async (t) => {
  for (const [index, f] of files.entries()) {
    await t.test(`local export ${index + 1}`, async () => {
      const tag = battleTagFromFilename(f)!;
      const bytes = new Uint8Array(await readFile(join(dir, f)));
      const t0 = performance.now();
      const r = await decodeExport(bytes, { battleTag: tag });
      const ms = Math.round(performance.now() - t0);
      const known = expectations[r.sourceSha256];
      if (known) {
        assert.equal(r.guides.length, known.guides);
        assert.equal(r.payload.length, known.bytes);
        assert.equal(r.payloadSha256, known.sha256, 'payload matches local expected checksum');
      } else {
        assert.ok(r.guides.length > 0);
      }
      for (const g of r.guides) assert.ok(g.name, `guide ${g.index} has a name`);
      t.diagnostic(`${r.guides.length} guides, ${r.payload.length} bytes, ${ms} ms${known ? ', matches local expectations' : ''}`);
    });
  }
});
