/**
 * Splits a large review diff into parts, each reviewed in its own turn (`REVIEW-002`).
 *
 * @remarks
 * Every line of the diff lands in exactly one part, in order. Whole files are kept together when
 * they fit; a larger file is split at hunk boundaries and a larger hunk at line boundaries, each
 * piece repeating its file header so the reviewer knows where it is. The parts are cut from the
 * diff text the server collected, so the snapshot of the whole diff still binds them.
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
  header: string;
  /** Hunks of a Git diff, or the content of an untracked file as one piece split by lines. */
  hunks: string[];
}

/** The start of a file: a Git diff header, or a line naming an untracked file as the server writes it. */
const FILE_START = /^(?:diff --git a\/.+|--- .+ ---)$/m;

/** Reads the files of a diff, keeping each file's header apart from its hunks. */
function filesOf(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const blocks = diff.split(new RegExp(`(?=${FILE_START.source})`, 'm')).filter(block => block.length > 0);
  for (const block of blocks) {
    if (block.startsWith('diff --git ')) {
      const path = /^diff --git a\/(.+?) b\//.exec(block)?.[1] ?? '(diff)';
      const firstHunk = block.search(/^@@ /m);
      if (firstHunk < 0) {
        files.push({ path, header: block, hunks: [] });
        continue;
      }
      const hunks = block
        .slice(firstHunk)
        .split(/(?=^@@ )/m)
        .filter(hunk => hunk.length > 0);
      files.push({ path, header: block.slice(0, firstHunk), hunks });
      continue;
    }
    const marker = /^--- (.+) ---$/m.exec(block);
    const lineEnd = block.indexOf('\n');
    const header = lineEnd < 0 ? block : block.slice(0, lineEnd + 1);
    const content = lineEnd < 0 ? '' : block.slice(lineEnd + 1);
    // The heading of the untracked section has the same shape as a file line, but names no file.
    const named = marker?.index === 0 && !marker[1]!.startsWith('UNTRACKED FILE SNAPSHOT');
    files.push({ path: named ? marker![1]! : '(diff preamble)', header, hunks: content ? [content] : [] });
  }
  return files;
}

/** Pieces of one file, each at most `budget` characters with its header, in order. */
function piecesOf(file: FileDiff, budget: number): string[] {
  const whole = file.header + file.hunks.join('');
  if (whole.length <= budget) return [whole];
  const room = Math.max(1, budget - file.header.length);
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    if (current) pieces.push(file.header + current);
    current = '';
  };
  for (const hunk of file.hunks) {
    if (hunk.length > room) {
      flush();
      // A hunk larger than a part: its lines in order. A Git hunk repeats its header, marked as
      // continued; an untracked file's content has none, so its file header says it.
      const gitHunk = hunk.startsWith('@@ ');
      const [first, ...rest] = hunk.split(/(?<=\n)/);
      const head = gitHunk ? first! : '';
      let piece = gitHunk ? first! : '';
      for (const line of gitHunk ? rest : [first!, ...rest]) {
        if (piece.length + line.length > room && piece !== head) {
          pieces.push(file.header + piece);
          piece = gitHunk ? `${head.trimEnd()} (continued)\n` : '(continued)\n';
        }
        piece += line;
      }
      pieces.push(file.header + piece);
      continue;
    }
    if (current.length + hunk.length > room) flush();
    current += hunk;
  }
  flush();
  return pieces;
}

/**
 * Splits a diff into parts of at most `budget` characters, keeping its order.
 * @param diff - The diff the server collected.
 * @param budget - Characters of one part.
 * @returns One part when the diff fits.
 */
export function splitReviewDiff(diff: string, budget = REVIEW_PART_CHARS): ReviewPart[] {
  if (diff.length <= budget) return [{ paths: filesOf(diff).map(file => file.path), text: diff }];
  const parts: ReviewPart[] = [];
  let current: ReviewPart = { paths: [], text: '' };
  const flush = () => {
    if (current.text) parts.push(current);
    current = { paths: [], text: '' };
  };
  for (const file of filesOf(diff)) {
    for (const piece of piecesOf(file, budget)) {
      if (current.text.length + piece.length > budget) flush();
      current.text += piece;
      if (!current.paths.includes(file.path)) current.paths.push(file.path);
    }
  }
  flush();
  return parts;
}
