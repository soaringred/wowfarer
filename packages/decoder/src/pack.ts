/**
 * Turn decoded guides into a companion addon for RXPGuides.
 *
 * The addon is a folder with a .toc that depends on RXPGuides and one Lua
 * file per guide. Each file hands the guide text to RXPGuides.RegisterGuide,
 * the same public function RXPGuides' own bundled guide files call, so the
 * guides load like built-in ones: no import window, no account step.
 */
import type { Guide } from './guide.ts';

export interface PackOptions {
  /** Folder and .toc name. Must be a valid addon folder name. Default "Wowfarer_Guides". */
  addonName?: string;
  /** Shown in the in-game addon list. */
  title?: string;
  /** Where the guides came from, for the TOC notes. */
  sourceTitle?: string;
  /** `## Interface:` value. Default matches current RXPGuides. */
  interfaceVersions?: string;
  version?: string;
}

/** Interface numbers RXPGuides v4.11 ships with, so the pack loads wherever it does. */
export const DEFAULT_INTERFACE = '11509, 38002, 50504, 120007, 120105, 16001';

export interface PackFile {
  /** Path inside the addon folder, forward slashes. */
  path: string;
  content: string;
}

export function buildCompanionAddon(guides: Guide[], options: PackOptions = {}): PackFile[] {
  const addonName = options.addonName ?? 'Wowfarer_Guides';
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(addonName)) {
    throw new Error(`Addon name "${addonName}" must be letters, digits and underscores.`);
  }
  const title = options.title ?? addonName.replace(/_/g, ' ');
  const version = options.version ?? new Date().toISOString().slice(0, 10);
  const notes = options.sourceTitle
    ? `Guides from "${options.sourceTitle}". Loads into RXPGuides.`
    : 'Guides decoded from your own export. Loads into RXPGuides.';

  const files: PackFile[] = [];
  const guidePaths: string[] = [];

  for (const g of guides) {
    const path = `Guides/${g.stem}.lua`;
    guidePaths.push(path);
    files.push({ path, content: guideLua(g) });
  }

  const toc = [
    `## Interface: ${options.interfaceVersions ?? DEFAULT_INTERFACE}`,
    `## Title: ${title}`,
    `## Notes: ${notes}`,
    `## Author: ${title}`,
    `## Version: ${version}`,
    `## Dependencies: RXPGuides`,
    `## X-Guide-Count: ${guides.length}`,
    `## X-Website: https://wowfarer.com`,
    '',
    ...guidePaths,
    '',
  ].join('\n');

  files.unshift({ path: `${addonName}.toc`, content: toc });
  return files;
}

function guideLua(g: Guide): string {
  const [open, close] = longBrackets(g.text);
  return [
    `-- ${g.name}`,
    `-- Group: ${g.group}`,
    `local RXP = _G.RXPGuides`,
    `if not (RXP and RXP.RegisterGuide) then return end`,
    `RXP.RegisterGuide(${open}`,
    g.text,
    `${close})`,
    '',
  ].join('\n');
}

/**
 * Pick a Lua long-bracket level the text cannot close early.
 * Lua skips a newline immediately after the opening bracket, so callers
 * always put one there and the guide's own leading newline survives.
 */
export function longBrackets(text: string): [string, string] {
  for (let level = 1; level < 64; level++) {
    const eq = '='.repeat(level);
    if (!text.includes(`]${eq}]`)) return [`[${eq}[`, `]${eq}]`];
  }
  throw new Error('Guide text closes every long-bracket level; cannot embed.');
}

/** Plain-text output: one file per guide. */
export function buildTextFiles(guides: Guide[]): PackFile[] {
  return guides.map((g) => ({ path: `${g.stem}.rxp.txt`, content: g.text }));
}
