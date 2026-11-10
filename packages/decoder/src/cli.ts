#!/usr/bin/env node
/**
 * wowfarer-decode <export...> --out <dir> [--battle-tag Name#1234]
 *                 [--addon-name Wowfarer_Guides] [--text]
 *
 * Decodes one or more exports and writes a companion addon folder into
 * --out. With --text, also writes one .rxp.txt per guide. The output
 * directory must not already exist.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { decodeExport, type DecodeResult } from './decode.ts';
import { FormatError } from './format.ts';
import { battleTagFromFilename, isBattleTag, titleFromFilename } from './guide.ts';
import { mergeGuides } from './merge.ts';
import { buildCompanionAddon, buildTextFiles } from './pack.ts';

interface Args {
  inputs: string[];
  out?: string;
  battleTag?: string;
  addonName: string;
  text: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { inputs: [], addonName: 'Wowfarer_Guides', text: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '-o' || v === '--out') a.out = argv[++i];
    else if (v === '--battle-tag') a.battleTag = argv[++i];
    else if (v === '--addon-name') a.addonName = argv[++i];
    else if (v === '--text') a.text = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (v.startsWith('-')) throw new Error(`Unknown option ${v}`);
    else a.inputs.push(v);
  }
  return a;
}

const USAGE = `Usage: wowfarer-decode <export...> --out <dir> [options]

Options:
  -o, --out <dir>          New output directory (required, must not exist)
  --battle-tag Name#1234   Tag the export was sold to; default: read from filename
  --addon-name <Name>      Companion addon folder name (default Wowfarer_Guides)
  --text                   Also write plain .rxp.txt files
  -h, --help               Show this help
`;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.inputs.length === 0 || !args.out) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }
  if (await exists(args.out)) {
    process.stderr.write(`Error: ${args.out} already exists. Choose a new directory.\n`);
    return 1;
  }
  if (args.battleTag && !isBattleTag(args.battleTag)) {
    process.stderr.write('Error: --battle-tag must look like Name#1234.\n');
    return 2;
  }

  const results: DecodeResult[] = [];
  const titles: string[] = [];
  for (const input of args.inputs) {
    const name = basename(input);
    const tag = args.battleTag ?? battleTagFromFilename(name);
    if (!tag) {
      process.stderr.write(
        `Error: no BattleTag in "${name}". Keep the original filename or pass --battle-tag.\n`,
      );
      return 1;
    }
    const bytes = new Uint8Array(await readFile(input));
    const result = await decodeExport(bytes, { battleTag: tag });
    const title = titleFromFilename(name);
    titles.push(title);
    results.push(result);
    process.stdout.write(
      `${title}: ${result.guides.length} guides, ${result.payload.length.toLocaleString()} bytes, sha256 ${result.payloadSha256.slice(0, 12)}…\n`,
    );
  }
  const { guides: allGuides, duplicates } = await mergeGuides(results);
  if (duplicates > 0) {
    process.stdout.write(`Skipped ${duplicates} guides that were identical across exports.\n`);
  }

  const files = buildCompanionAddon(allGuides, {
    addonName: args.addonName,
    sourceTitle: titles.join('; '),
  });
  const addonRoot = join(args.out, args.addonName);
  for (const f of files) {
    const p = join(addonRoot, f.path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content, 'utf8');
  }
  if (args.text) {
    for (const f of buildTextFiles(allGuides)) {
      const p = join(args.out, 'text', f.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.content, 'utf8');
    }
  }
  process.stdout.write(`Wrote ${addonRoot} (${allGuides.length} guides). Drop that folder into Interface/AddOns.\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const msg = err instanceof FormatError ? err.message : err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  },
);
