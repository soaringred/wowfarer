/**
 * Round-trip tests using synthetic guides. No RestedXP content is involved:
 * we build an export of our own text with the same container shape, then
 * decode it. This is what runs in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { adler32, cipher, cipherState, deriveKey } from '../src/format.ts';
import { decodeExport } from '../src/decode.ts';
import { buildCompanionAddon, longBrackets } from '../src/pack.ts';
import { battleTagFromFilename } from '../src/guide.ts';

const TAG = 'Tester#4242';

function encodeBlock(text: string, tag: string): string {
  const plain = new TextEncoder().encode(text);
  const zlibBytes = new Uint8Array(deflateSync(plain)); // zlib-wrapped by default
  const enc = cipher(zlibBytes, cipherState(deriveKey(tag)));
  const b64 = Buffer.from(enc).toString('base64');
  return `${adler32(plain)}:${b64}%`;
}

function makeExport(guides: string[][], tag = TAG, marker = 40000): string {
  // guides: one array of guide texts per block
  const count = guides.reduce((n, b) => n + b.length, 0);
  const blocks = guides.map((b) => encodeBlock(b.join('\0') + '\0', tag)).join('');
  return `${count}|${blocks}|${marker}`;
}

const g1 = `\n#classic\n<< Horde\n#name 1-6 Valley of Trials\n#group Test Group\nstep\n.goto Durotar,43.2,68.5\n.accept 4641 >> Accept Your Place In The World\nstep\n.turnin 4641 >> Turn in\n`;
const g2 = `#name 6-10 Durotar\n#group Test Group\nstep\n.goto Durotar,52.0,43.0\nstep\n.xp 10 >> Grind to 10\n`;
const g3 = `#name Weird ]] brackets ]=] inside\n#group Edge Cases\nstep\n.goto 1,2,3 >> Text with ]] and ]=]\n`;

test('decodes a single-block export and preserves bytes', async () => {
  const r = await decodeExport(makeExport([[g1, g2]]), { battleTag: TAG });
  assert.equal(r.declaredCount, 2);
  assert.equal(r.formatVersion, 40000);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.guides[0].name, '1-6 Valley of Trials');
  assert.equal(r.guides[0].group, 'Test Group');
  assert.deepEqual(r.guides[0].conditions, ['Horde']);
  assert.equal(r.guides[0].stepCount, 2);
  assert.equal(r.guides[0].text, g1);
  assert.equal(r.guides[1].text, g2);
  assert.equal(r.guides[0].stem, '001-1-6-valley-of-trials');
});

test('decodes multiple blocks with a fresh cipher state per block', async () => {
  const r = await decodeExport(makeExport([[g1], [g2, g3]]), { battleTag: TAG });
  assert.equal(r.blocks.length, 2);
  assert.equal(r.guides.length, 3);
  assert.equal(r.guides[2].text, g3);
});

test('tag matching is ASCII case-insensitive, like the addon', async () => {
  const r = await decodeExport(makeExport([[g1]]), { battleTag: 'tESTER#4242' });
  assert.equal(r.guides.length, 1);
});

test('rejects the wrong BattleTag without producing output', async () => {
  await assert.rejects(
    decodeExport(makeExport([[g1]]), { battleTag: 'Someone#1' }),
    (e: any) => e.code === 'wrong-tag',
  );
});

test('rejects a count mismatch', async () => {
  const bad = makeExport([[g1, g2]]).replace(/^2\|/, '3|');
  await assert.rejects(decodeExport(bad, { battleTag: TAG }), (e: any) => e.code === 'count-mismatch');
});

test('rejects a tampered payload', async () => {
  const good = makeExport([[g1, g2]]);
  const i = good.indexOf(':') + 40;
  const flipped = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
  await assert.rejects(decodeExport(flipped, { battleTag: TAG }));
});

test('rejects things that are not exports', async () => {
  await assert.rejects(decodeExport('hello world', { battleTag: TAG }), (e: any) => e.code === 'not-an-export');
  await assert.rejects(decodeExport('0|1:QUJD%|40000', { battleTag: TAG }), (e: any) => e.code === 'empty');
});

test('tolerates BOM and surrounding whitespace', async () => {
  const r = await decodeExport('﻿  ' + makeExport([[g1]]) + '\r\n', { battleTag: TAG });
  assert.equal(r.guides.length, 1);
});

test('long brackets never close early', () => {
  assert.deepEqual(longBrackets('plain'), ['[=[', ']=]']);
  assert.deepEqual(longBrackets('has ]=] in it'), ['[==[', ']==]']);
  assert.deepEqual(longBrackets('has ]=] and ]==]'), ['[===[', ']===]']);
});

test('companion addon has a TOC that lists every guide file', async () => {
  const r = await decodeExport(makeExport([[g1, g2, g3]]), { battleTag: TAG });
  const files = buildCompanionAddon(r.guides, { addonName: 'Test_Guides', sourceTitle: 'Unit test' });
  const toc = files.find((f) => f.path === 'Test_Guides.toc');
  assert.ok(toc);
  assert.match(toc.content, /^## Dependencies: RXPGuides$/m);
  assert.match(toc.content, /^## X-Guide-Count: 3$/m);
  for (const f of files.filter((f) => f.path.startsWith('Guides/'))) {
    assert.ok(toc.content.includes(f.path), `TOC lists ${f.path}`);
    assert.match(f.content, /RXP\.RegisterGuide\(\[=+\[\n/);
    assert.match(f.content, /\n\]=+\]\)\n$/);
  }
  const weird = files.find((f) => f.path.includes('weird'));
  assert.ok(weird);
  assert.ok(weird.content.includes('[==[\n'), 'escalated bracket level for ]=] in text');
  assert.ok(weird.content.includes(g3), 'guide text embedded verbatim');
});

test('reads the BattleTag off an export filename', () => {
  assert.equal(battleTagFromFilename('Some Guide Bundle!Name#1234'), 'Name#1234');
  assert.equal(battleTagFromFilename('/x/y/Some Guide Bundle!Name#1234.txt'), 'Name#1234');
  assert.equal(battleTagFromFilename('Renamed.txt'), null);
});
