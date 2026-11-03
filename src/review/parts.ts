/**
 * Splits a large review diff into parts, each reviewed in its own turn (`REVIEW-002`).
 *
 * @remarks
 * Every character of the diff lands in exactly one part, in order, and no part exceeds the
 * budget. Whole files are kept together when they fit; a larger file is split at hunk boundaries,
 * a larger hunk at line boundaries and a longer line at the budget, each piece repeating its file
 * header so the reviewer knows where it is. Untracked files are cut where the collector recorded
 * them, never where their content looks like a heading. The parts are cut from the diff text the
 * server collected, so the snapshot of the whole diff still binds them.
 *
 * @packageDocumentation
 */
import type { GitScopeInfo } from '../workspace/git.js';

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
  /** Git hunks, or one block of plain content (an untracked file, a block without hunks). */
  hunks: string[];
}

/** The text of one file, header apart: Git hunks are kept as hunks, anything else as plain content. */
function toFile(path: string, text: string, git: boolean): FileDiff {
  const lines = text.split(/(?<=\n)/);
  const firstHunk = git ? lines.findIndex(line => line.startsWith('@@ ')) : -1;
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

/**
 * The path of a `diff --git` header line, also when Git quoted it for special characters.
 */
function gitPath(line: string): string {
  const quoted = /^diff --git "a\/((?:[^"\\]|\\.)*)"/.exec(line);
  return quoted ? unquoteGitPath(quoted[1]!) : (/^diff --git a\/(.+?) b\//.exec(line)?.[1] ?? '(diff)');
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decodes Git's C quoting: escaped characters, and octal escapes as the bytes of UTF-8 text. */
export function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    const char = quoted[i]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      const next = quoted[i + 1] ?? '';
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Reads the files of a diff. A Git file starts at `diff --git `, which cannot begin a line of
 * hunk content, since those lines start with +, - or a space. Untracked files start where the
 * collector recorded them.
 */
function filesOf(diff: string, untracked: GitScopeInfo['untracked']): FileDiff[] {
  const files: FileDiff[] = [];
  const gitEnd = untracked ? untracked.section : diff.length;
  let current: { path: string; text: string } | null = null;
  for (const line of diff.slice(0, gitEnd).split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(toFile(current.path, current.text, true));
      current = { path: gitPath(line), text: line };
    } else if (current) current.text += line;
    else current = { path: '(diff preamble)', text: line };
  }
  if (current) files.push(toFile(current.path, current.text, true));
  if (!untracked) return files;
  const starts = [{ path: '(untracked files)', offset: untracked.section }, ...untracked.files];
  for (const [index, start] of starts.entries()) {
    const text = diff.slice(start.offset, starts[index + 1]?.offset ?? diff.length);
    if (text) files.push(toFile(start.path, text, false));
  }
  return files;
}

/** Pieces of one file, each at most `budget` characters with its header, in order. */
function piecesOf(file: FileDiff, budget: number): string[] {
  const whole = file.header + file.hunks.join('');
  if (whole.length <= budget) return [whole];
  const pieces: string[] = [];
  const room = budget - file.header.length;
  let current = '';
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
    // A hunk larger than a piece: its lines in order, every later piece marked as a continuation,
    // and a line longer than a piece cut at the budget. A hunk header too long to repeat is content.
    const lines = hunk.split(/(?<=\n)/);
    const repeat = hunk.startsWith('@@ ') && lines[0]!.length * 4 <= room;
    const head = repeat ? lines.shift()! : '';
    const marker = repeat ? `${head.replace(/\r?\n$/, '')} (continued)\n` : '(continued)\n';
    let piece = head;
    const started = () => piece !== head && piece !== marker;
    for (const line of lines) {
      let rest = line;
      while (rest) {
        const space = room - piece.length;
        // A whole line goes to a fresh piece rather than being cut, when one can hold it.
        if (space <= 0 || (rest.length > space && started() && rest.length <= room - marker.length)) {
          pieces.push(file.header + piece);
          piece = marker;
          continue;
        }
        piece += rest.slice(0, space);
        rest = rest.slice(space);
      }
    }
    if (started() || (piece === head && head)) pieces.push(file.header + piece);
  }
  flush();
  return pieces;
}

/**
 * Splits a diff into parts of at most `budget` characters, keeping its order.
 * @param diff - The diff the server collected.
 * @param untracked - Where the collector wrote untracked files into it.
 * @param budget - Characters of one part.
 * @returns One part when the diff fits.
 */
export function splitReviewDiff(diff: string, untracked?: GitScopeInfo['untracked'], budget = REVIEW_PART_CHARS): ReviewPart[] {
  const files = filesOf(diff, untracked);
  if (diff.length <= budget) return [{ paths: [...new Set(files.map(file => file.path))], text: diff }];
  const parts: ReviewPart[] = [];
  let current: ReviewPart = { paths: [], text: '' };
  const flush = () => {
    if (current.text) parts.push(current);
    current = { paths: [], text: '' };
  };
  for (const file of files) {
    // A header too large to repeat on every piece is cut like content: the file still lands somewhere.
    const fitting = file.header.length * 4 > budget ? { ...file, header: '', hunks: [file.header + file.hunks.join('')] } : file;
    for (const piece of piecesOf(fitting, budget)) {
      if (current.text.length + piece.length > budget) flush();
      current.text += piece;
      if (!current.paths.includes(file.path)) current.paths.push(file.path);
    }
  }
  flush();
  return parts;
}
