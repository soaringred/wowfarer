/**
 * Wires the page to the decoder. Everything here runs in the visitor's
 * browser. There is no fetch, no XHR, no beacon: the page's Content Security
 * Policy forbids them, so a regression would fail loudly.
 *
 * BattleTag flow:
 *   - file dropped, tag in its name  -> field is prefilled, decoding starts
 *   - file dropped, no tag in name   -> ask for the tag, decode on Enter
 *   - wrong tag                      -> file stays loaded, fix tag, Enter
 *   - not an export at all           -> say so straight away
 *
 * A file can be dropped anywhere on the page at any time, including over a
 * finished result; it replaces whatever was there.
 */
import { strToU8, zipSync } from 'fflate';
import {
  FormatError,
  battleTagFromFilename,
  buildCompanionAddon,
  buildTextFiles,
  decodeExport,
  isBattleTag,
  mergeGuides,
  parseContainer,
  titleFromFilename,
  type DecodeResult,
  type Guide,
} from '@wowfarer/decoder';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const drop = $<HTMLLabelElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const tagInput = $<HTMLInputElement>('tag');
const tagGo = $<HTMLButtonElement>('tag-go');
const tagHint = $('tag-hint');
const panels = {
  idle: $('state-idle'),
  working: $('state-working'),
  error: $('state-error'),
  needtag: $('state-needtag'),
  result: $('state-result'),
};
type Panel = keyof typeof panels;

const ADDON_NAME = 'Wowfarer_Guides';
const TAG_HINT = 'Read from the filename. Only needed if you renamed the file.';
const NEED_HINT = 'It’s the tag the export was downloaded under, like Name#1234. Press Enter to decode.';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** 'retry' is an error the BattleTag field can fix, so the drop zone stays out of the way. */
type State = Panel | 'retry';

/** Which panels each state shows. The drop zone stays up after an error. */
const VISIBLE: Record<State, Panel[]> = {
  idle: ['idle'],
  working: ['working'],
  error: ['error', 'idle'],
  retry: ['error'],
  needtag: ['needtag'],
  result: ['result'],
};

interface Decoded {
  titles: string[];
  results: DecodeResult[];
  guides: Guide[];
  duplicates: number;
}

let pending: File[] = [];
let current: Decoded | null = null;
/** The tag in the field at the last decode attempt, and whether it worked. */
let lastTried: string | null = null;
let lastOk = false;
/** Tag we prefilled from the filename, if any. */
let prefilled: string | null = null;
let workingTimer: number | undefined;

function show(state: State): void {
  window.clearTimeout(workingTimer);
  const visible = VISIBLE[state];
  const lead: Panel = state === 'retry' ? 'error' : state;
  for (const [name, el] of Object.entries(panels) as [Panel, HTMLElement][]) {
    const on = visible.includes(name);
    const wasHidden = el.classList.contains('hidden');
    el.classList.toggle('hidden', !on);
    // Replay the entrance animation whenever a panel appears or changes content.
    if (on && (wasHidden || name === lead)) {
      el.classList.remove('enter');
      void el.offsetWidth;
      el.classList.add('enter');
    }
  }
}

/** Decoding is usually instant; only show the spinner if it isn't. */
function showWorkingSoon(): void {
  window.clearTimeout(workingTimer);
  workingTimer = window.setTimeout(() => show('working'), 150);
}

/**
 * The BattleTag field carries its state in its border and the hint line
 * under it: gold when the tag is needed, red when it is wrong, plain otherwise.
 */
function setTagState(kind: 'ok' | 'need' | 'bad' | null, hint = TAG_HINT, shake = true): void {
  tagInput.classList.toggle('is-need', kind === 'need');
  const wasBad = tagInput.classList.contains('is-bad');
  if (kind !== 'bad' || shake || !wasBad) tagInput.classList.remove('is-bad');
  if (kind === 'bad' && !tagInput.classList.contains('is-bad')) {
    if (shake) void tagInput.offsetWidth; // restart the shake
    tagInput.classList.toggle('no-shake', !shake);
    tagInput.classList.add('is-bad');
  }
  tagInput.setAttribute('aria-invalid', kind === 'bad' ? 'true' : 'false');
  tagHint.classList.toggle('is-bad', kind === 'bad');
  tagHint.classList.toggle('is-need', kind === 'need');
  tagHint.textContent = hint;
}

function setGoVisible(visible: boolean): void {
  tagGo.classList.toggle('hidden', !visible);
}

function fail(title: string, detail: string, state: 'error' | 'retry' = 'error'): void {
  $('error-title').textContent = title;
  $('error-detail').textContent = detail;
  show(state);
}

/** Entry point for a drop or a file-picker choice. */
async function handleFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;

  // Reject anything that isn't an export before asking for a BattleTag.
  for (const file of list) {
    try {
      parseContainer(await file.text());
    } catch {
      pending = [];
      setTagState(null);
      setGoVisible(false);
      fail(
        'That isn’t a guide export.',
        `"${file.name}" doesn’t contain RestedXP export data. Drop the file you downloaded from RestedXP.`,
      );
      return;
    }
  }

  pending = list;
  lastTried = null;
  lastOk = false;
  const found = list.map((f) => battleTagFromFilename(f.name)).find((t): t is string => Boolean(t)) ?? null;

  if (found) {
    // A new file brings its own tag; it replaces whatever the field held.
    tagInput.value = found;
    prefilled = found;
    setTagState('ok', 'Read from the filename.');
  } else if (prefilled && tagInput.value.trim() === prefilled) {
    // The field still shows the previous file's tag, which says nothing about this one.
    tagInput.value = '';
    prefilled = null;
    setTagState(null);
  }

  const haveTagForAll = list.every((f) => battleTagFromFilename(f.name)) || isBattleTag(tagInput.value.trim());
  if (!haveTagForAll) {
    askForTag();
    return;
  }
  await decodePending();
}

function askForTag(): void {
  const names = pending.map((f) => f.name).join(', ');
  $('needtag-files').textContent =
    pending.length === 1
      ? `"${names}" has no BattleTag in its name, so we can't read the key from it.`
      : `Some of these files have no BattleTag in their names: ${names}`;
  setTagState('need', NEED_HINT);
  setGoVisible(true);
  show('needtag');
  tagInput.focus();
}

/** Decide which tag applies to each pending file. */
function tagFor(file: File): string | null {
  const typed = tagInput.value.trim();
  const own = battleTagFromFilename(file.name);
  // An unedited prefill means "use each file's own tag"; an edit overrides all.
  if (typed && typed !== prefilled) return typed;
  return own ?? (typed || null);
}

async function decodePending(): Promise<void> {
  if (pending.length === 0) return;
  const typed = tagInput.value.trim();
  if (typed && !isBattleTag(typed)) {
    setTagState('bad', 'That doesn’t look like a BattleTag. It should look like Name#1234.');
    tagInput.focus();
    return;
  }

  lastTried = typed || null;
  lastOk = false;
  showWorkingSoon();
  setGoVisible(false);
  const results: DecodeResult[] = [];
  const titles: string[] = [];
  let tagInUse: string | null = null;

  try {
    for (const file of pending) {
      const tag = tagFor(file);
      if (!tag) {
        askForTag();
        return;
      }
      tagInUse = tag;
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push(await decodeExport(bytes, { battleTag: tag }));
      titles.push(titleFromFilename(file.name));
    }
  } catch (e) {
    if (e instanceof FormatError && e.code === 'wrong-tag') {
      setTagState('bad', 'This tag didn’t open the file. Edit it and press Enter to try again.');
      setGoVisible(true);
      fail(
        'This export didn’t open with that BattleTag.',
        'Check the tag it was downloaded under. The file is still loaded, so just fix the tag below.',
        'retry',
      );
      tagInput.focus();
      tagInput.select();
      return;
    }
    const title = e instanceof FormatError ? headline(e.code) : 'Something went wrong while decoding.';
    const detail = e instanceof Error ? e.message : String(e);
    setGoVisible(false);
    fail(title, detail);
    return;
  }

  lastOk = true;
  const merged = await mergeGuides(results);
  current = { titles, results, guides: merged.guides, duplicates: merged.duplicates };
  render(current);
  setTagState('ok', tagInUse === prefilled ? 'Read from the filename.' : 'Used to decode this export.');
  setGoVisible(false);
  tagInput.blur();
  show('result');
  bringIntoView(panels.result);
}

function headline(code: string): string {
  switch (code) {
    case 'not-an-export':
      return 'That isn’t a guide export.';
    case 'count-mismatch':
    case 'checksum-mismatch':
    case 'inflate-failed':
    case 'malformed-block':
      return 'The file didn’t verify.';
    default:
      return 'Couldn’t decode that file.';
  }
}

function render(d: Decoded): void {
  const steps = d.guides.reduce((n, g) => n + g.stepCount, 0);
  const bytes = d.results.reduce((n, r) => n + r.payload.length, 0);
  const blocks = d.results.reduce((n, r) => n + r.blocks.length, 0);

  $('r-title').textContent = d.titles.join(' + ');
  const meta = $('r-meta');
  meta.textContent = `${fmtBytes(bytes)} · ${blocks} block${blocks === 1 ? '' : 's'} · `;
  const ok = document.createElement('span');
  ok.className = 'ok';
  ok.textContent = 'verified against every checksum';
  meta.appendChild(ok);
  if (d.duplicates > 0) meta.append(` · ${d.duplicates} duplicate${d.duplicates === 1 ? '' : 's'} skipped`);

  countUp($('r-guides'), d.guides.length, (n) => n.toLocaleString());
  countUp($('r-steps'), steps, (n) => n.toLocaleString());
  countUp($('r-size'), bytes, fmtBytes);

  const groups = new Map<string, number>();
  for (const g of d.guides) {
    const key = g.group || 'Ungrouped';
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const ul = $('r-groups');
  ul.replaceChildren();
  [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count], i) => {
      const li = document.createElement('li');
      li.style.setProperty('--i', String(Math.min(i, 12)));
      const n = document.createElement('span');
      n.className = 'g-name';
      n.textContent = name;
      const c = document.createElement('span');
      c.className = 'g-count';
      c.textContent = String(count);
      li.append(n, c);
      ul.appendChild(li);
    });
  $('r-path').textContent = `Interface/AddOns/${ADDON_NAME}`;
}

/** Count a figure up from zero. Instant when the visitor prefers less motion. */
function countUp(el: HTMLElement, to: number, format: (n: number) => string): void {
  el.textContent = format(to);
  if (reduceMotion.matches || to === 0) return;
  const start = performance.now();
  const duration = 650;
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = format(k === 1 ? to : Math.round(to * eased));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** On small screens the result can land below the fold; bring it up. */
function bringIntoView(el: HTMLElement): void {
  const top = el.getBoundingClientRect().top;
  if (top > window.innerHeight * 0.7 || top < 0) {
    el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function downloadZip(files: { path: string; content: string }[], root: string, filename: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${root}/${f.path}`] = strToU8(f.content);
  const zipped = zipSync(entries, { level: 6 });
  const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Brief confirmation on a download button, then back to its label. */
const flashTimers = new WeakMap<HTMLElement, number>();
function confirmDownload(btn: HTMLElement): void {
  const label = btn.dataset.label ?? btn.textContent ?? '';
  btn.dataset.label = label;
  btn.textContent = 'Downloaded';
  btn.classList.add('is-done');
  window.clearTimeout(flashTimers.get(btn));
  flashTimers.set(
    btn,
    window.setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-done');
    }, 2000),
  );
}

function resetAll(): void {
  pending = [];
  current = null;
  lastTried = null;
  lastOk = false;
  prefilled = null;
  fileInput.value = '';
  tagInput.value = '';
  setTagState(null);
  setGoVisible(false);
  show('idle');
}

const dlAddon = $<HTMLButtonElement>('dl-addon');
dlAddon.addEventListener('click', () => {
  if (!current) return;
  const files = buildCompanionAddon(current.guides, {
    addonName: ADDON_NAME,
    sourceTitle: current.titles.join('; '),
  });
  downloadZip(files, ADDON_NAME, `${ADDON_NAME}.zip`);
  confirmDownload(dlAddon);
});
const dlText = $<HTMLButtonElement>('dl-text');
dlText.addEventListener('click', () => {
  if (!current) return;
  downloadZip(buildTextFiles(current.guides), 'guides', 'wowfarer-guides-text.zip');
  confirmDownload(dlText);
});
$('reset').addEventListener('click', resetAll);

// Tag field: Enter or the button decodes whatever is pending.
tagGo.addEventListener('click', () => void decodePending());
tagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void decodePending();
  }
});
tagInput.addEventListener('input', () => {
  const v = tagInput.value.trim();
  if (pending.length === 0) {
    setTagState(null);
    setGoVisible(false);
    return;
  }

  // Same tag as the last attempt: nothing new to try. Show how that attempt went.
  if (lastTried !== null && v === lastTried) {
    setGoVisible(false);
    if (lastOk) setTagState('ok', lastTried === prefilled ? 'Read from the filename.' : 'Used to decode this export.');
    else setTagState('bad', 'This tag didn’t open the file. Edit it and press Enter to try again.', false);
    return;
  }

  const isShown = (p: Panel) => !panels[p].classList.contains('hidden');
  setGoVisible(v.length > 0);
  if (isShown('needtag') || !v) setTagState('need', NEED_HINT);
  else setTagState(null, 'Press Enter to decode with this tag.');
});

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) void handleFiles(fileInput.files);
  // Allow choosing the same file again later.
  fileInput.value = '';
});

drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

// Page-wide drag and drop. One handler for the whole window, so a file is
// decoded once wherever it lands, and it works over a finished result too.
let dragDepth = 0;
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
const dropTitle = drop.querySelector<HTMLElement>('.drop-title');
const DROP_TITLE = dropTitle?.textContent ?? '';
/**
 * While a file is dragged over the window: if the drop zone is on screen it
 * lights up gold; otherwise (for example over a finished result) a page-wide
 * overlay appears. A drop anywhere is accepted either way.
 */
const setDragging = (on: boolean) => {
  const zoneShown = !panels.idle.classList.contains('hidden');
  document.body.classList.toggle('is-dragging', on);
  document.body.classList.toggle('drag-overlay-on', on && !zoneShown);
  drop.classList.toggle('is-target', on && zoneShown);
  if (dropTitle) dropTitle.textContent = on && zoneShown ? 'Release to decode' : DROP_TITLE;
};

window.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  setDragging(true);
});
window.addEventListener('dragleave', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDragging(false);
});
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const files = e.dataTransfer?.files;
  if (files && files.length) void handleFiles(files);
});
window.addEventListener('blur', () => {
  dragDepth = 0;
  setDragging(false);
});

show('idle');
