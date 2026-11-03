/**
 * Splits a large review diff into parts, each reviewed in its own turn (`REVIEW-002`).
 *
 * @remarks
 * Every character of the diff lands in exactly one part, in order. Whole files are kept together
 * when they fit; a larger file is split at hunk boundaries, a larger hunk at line boundaries and a
 * longer line at the budget, each piece repeating its file header so the reviewer knows where it
 * is. The parts are cut from the diff text the server collected, so the snapshot of the whole diff
 * still binds them.
 *
 * @packageDocumentation
 */

/** Diff characters of one part; with the prompt around it, it stays far below any backend's input limit. */
export const REVIEW_PART_CHARS = 200_000;

/** Parts at most: a change above this is refused before any turn and the caller narrows the scope. */
export const MAX_REVIEW_PARTS = 15;

/** One part of a diff. */
export interface ReviewPart {
  /** The paths whose lines this part holds. */
  paths: string[];
  text: string;
}

interface FileDiff {
  path: string;
  /** What starts every piece of the file. */
  header: string;
  /** Git hunks, or one block of an untracked file's content, split by lines when too large. */
  hunks: string[];
}

/** The heading the server writes before the content of untracked files. */
const UNTRACKED_SECTION = '--- UNTRACKED FILE SNAPSHOT';

/**
 * Reads the files of a diff. A Git file starts at `diff --git a/`, which cannot begin a line of
 * hunk content, since those lines start with +, - or a space. In the untracked section a file
 * starts only at `--- <path> ---` for a path the scope changes: a file's own content may hold such
 * a line, and it then stays content.
 */
function filesOf(diff: string, changedPaths: ReadonlySet<string>): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { path: string; lines: string[] } | null = null;
  let untracked = false;
  const close = () => {
    if (current) files.push(toFile(current.path, current.lines));
    current = null;
  };
  for (const line of diff.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '');
    if (!untracked && bare.startsWith('diff --git a/')) {
      close();
      current = { path: /^diff --git a\/(.+?) b\//.exec(bare)?.[1] ?? '(diff)', lines: [line] };
      continue;
    }
    if (!untracked && bare.startsWith(UNTRACKED_SECTION)) {
      close();
      untracked = true;
      current = { path: '(diff preamble)', lines: [line] };
      continue;
    }
    const named = untracked ? /^--- (.+) ---$/.exec(bare)?.[1] : undefined;
    if (named !== undefined && changedPaths.has(named)) {
      close();
      current = { path: named, lines: [line] };
      continue;
    }
    if (!current) current = { path: '(diff preamble)', lines: [] };
    current.lines.push(line);
  }
  close();
  return files;
}

function toFile(path: string, lines: string[]): FileDiff {
  const firstHunk = lines.findIndex(line => line.startsWith('@@ '));
  // Without hunks (a binary marker, a mode change, an untracked file) the first line heads the rest.
  const headerEnd = firstHunk < 0 ? Math.min(1, lines.length) : firstHunk;
  const header = lines.slice(0, headerEnd).join('');
  const body = lines.slice(headerEnd);
  if (firstHunk < 0) return { path, header, hunks: body.length ? [body.join('')] : [] };
  const hunks: string[] = [];
  for (const line of body) {
    if (line.startsWith('@@ ') || !hunks.length) hunks.push(line);
    else hunks[hunks.length - 1] += line;
  }
  return { path, header, hunks };
}

/** Pieces of one file, each at most `budget` characters with its header, in order. */
function piecesOf(file: FileDiff, budget: number): string[] {
  const whole = file.header + file.hunks.join('');
  if (whole.length <= budget) return [whole];
  const pieces: string[] = [];
  let current = '';
  const room = budget - file.header.length;
  const flush = () => {
    if (current) pieces.push(file.header + current);
    current = '';
  };
  for (const hunk of file.hunks) {
    if (hunk.length <= room) {
      if (current.length + hunk.length > room) flush();
      current += hunk;
      continue;
    }
    flush();
    // A hunk larger than a part: its lines in order, every later piece marked as a continuation
    // of the same hunk, and a line longer than a piece cut at the budget.
    const gitHunk = hunk.startsWith('@@ ');
    const lines = hunk.split(/(?<=\n)/);
    const head = gitHunk ? lines.shift()! : '';
    const marker = gitHunk ? `${head.replace(/\r?\n$/, '')} (continued)\n` : '(continued)\n';
    let piece = head;
    const space = () => room - piece.length;
    for (const line of lines) {
      let rest = line;
      while (rest) {
        if (rest.length > space() && piece && piece !== head) {
          pieces.push(file.header + piece);
          piece = marker;
        }
        const take = rest.length <= space() ? rest.length : Math.max(1, space());
        piece += rest.slice(0, take);
        rest = rest.slice(take);
      }
    }
    if (piece) pieces.push(file.header + piece);
  }
  flush();
  return pieces;
}

/**
 * Splits a diff into parts of at most `budget` characters, keeping its order.
 * @param diff - The diff the server collected.
 * @param changedPaths - The paths the scope changes, which name its untracked files.
 * @param budget - Characters of one part; it must leave room for a file header and a continuation line.
 * @returns One part when the diff fits.
 */
export function splitReviewDiff(diff: string, changedPaths: readonly string[] = [], budget = REVIEW_PART_CHARS): ReviewPart[] {
  const files = filesOf(diff, new Set(changedPaths));
  if (diff.length <= budget) return [{ paths: [...new Set(files.map(file => file.path))], text: diff }];
  const parts: ReviewPart[] = [];
  let current: ReviewPart = { paths: [], text: '' };
  const flush = () => {
    if (current.text) parts.push(current);
    current = { paths: [], text: '' };
  };
  for (const file of files) {
    // A header that leaves no room for content is cut like content: the file still lands somewhere.
    const fitting = file.header.length * 2 > budget ? { ...file, header: '', hunks: [file.header + file.hunks.join('')] } : file;
    for (const piece of piecesOf(fitting, budget)) {
      if (current.text.length + piece.length > budget) flush();
      current.text += piece;
      if (!current.paths.includes(file.path)) current.paths.push(file.path);
    }
  }
  flush();
  return parts;
}
