#!/usr/bin/env node
// Copies the agent standards into a project and checks that the copy is
// unchanged. A project keeps the files in its own checkout, so every agent and
// CI job reads them without network access or an install step; the lock file
// records which release they came from (README "Adopting").
//
//   node agent-standards.mjs sync --source <git url or checkout> --ref <tag>
//   node agent-standards.mjs check [--source <git url or checkout>]
//
// Both commands run in the project root (or pass --target <dir>). Only Node
// built-ins and the git CLI are used, so the script runs the same on Windows,
// Linux and macOS.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const LOCK_FILE = ".agents/standards.lock.json"
const SCHEMA_VERSION = 1
// Managed files never leave these directories of the project, whatever a
// manifest or a lock says, so a release cannot write or delete project code,
// project rules or skills (README "Layout in a project").
const MANAGED_ROOTS = [".agents/rules/core", ".agents/standards"]

/** Runs git and returns its stdout as a Buffer; git errors propagate. */
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/**
 * Hash of a file's text with CRLF turned into LF. A checkout with
 * `core.autocrlf=true` on Windows writes CRLF; hashing the raw bytes would
 * report every file as changed there.
 */
function contentHash(buffer) {
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n")
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Parses `--name value` pairs after the command. */
function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]
    if (!name.startsWith("--") || args[i + 1] === undefined) {
      throw new Error(`Expected --name value pairs, got "${name}"`)
    }
    options[name.slice(2)] = args[i + 1]
  }
  return options
}

/**
 * Opens the source as a git repository: a local checkout is used in place, a
 * URL is cloned bare into a temporary directory that `close` removes.
 */
function openSource(source) {
  if (existsSync(source)) {
    return { dir: source, close() {} }
  }
  const dir = mkdtempSync(join(tmpdir(), "agent-standards-"))
  try {
    // `--` keeps a source that starts with a dash from being read as an option.
    execFileSync("git", ["clone", "--quiet", "--bare", "--", source, dir], {
      stdio: ["ignore", "ignore", "pipe"],
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Whether a path is a canonical relative path: forward slashes only (a
 * backslash is a separator on Windows), no empty, `.` or `..` segment, no
 * drive letter.
 */
function isCanonical(path) {
  return (
    typeof path === "string" &&
    !path.includes("\\") &&
    !/^[a-zA-Z]:/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  )
}

/** Whether a path is a canonical path at or below one of the managed roots. */
function isCanonicalManagedPath(path) {
  return (
    isCanonical(path) &&
    MANAGED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
  )
}

/** Validates the managed directories and the files inside them. */
function assertManagedLayout(managedDirectories, paths) {
  if (!Array.isArray(managedDirectories) || managedDirectories.length === 0) {
    throw new Error("managedDirectories must be a non-empty list")
  }
  for (const dir of managedDirectories) {
    if (!isCanonicalManagedPath(dir)) {
      throw new Error(
        `Managed directory "${dir}" is not a canonical path in ${MANAGED_ROOTS.join(" or ")}`
      )
    }
    // Nested or repeated directories would list the same file twice.
    const overlapping = managedDirectories.filter(
      (other) =>
        other === dir ||
        other.startsWith(`${dir}/`) ||
        dir.startsWith(`${other}/`)
    )
    if (overlapping.length > 1) {
      throw new Error(
        `Managed directory "${dir}" overlaps another managed directory`
      )
    }
  }
  for (const path of paths) {
    const inside = managedDirectories.some((dir) => path.startsWith(`${dir}/`))
    if (!isCanonicalManagedPath(path) || !inside) {
      throw new Error(`Target "${path}" is outside the managed directories`)
    }
  }
}

// One name component every supported file system stores as written: lowercase
// letters, digits, `_` and `-`, parts joined by single dots, an optional
// leading dot, no trailing dot or space.
const PORTABLE_NAME = /^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/
// Windows device names, also with an extension.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/

/**
 * Refuses release targets whose names are not portable, and targets where a
 * file would also be the directory of another. Windows and macOS compare
 * names without case and Windows drops trailing dots and spaces, so names
 * that differ only there would clash; portable names rule that out on every
 * system.
 */
function assertNoClashes(paths) {
  for (const path of paths) {
    const portable = path
      .split("/")
      .every((part) => PORTABLE_NAME.test(part) && !RESERVED_NAME.test(part))
    if (!portable) {
      throw new Error(
        `Target "${path}" is not a portable name (lowercase letters, digits, _ - and dots)`
      )
    }
    // Two sources for one target would silently drop one of them.
    const clashes = paths.filter(
      (other) => other === path || other.startsWith(`${path}/`)
    )
    if (clashes.length > 1) {
      throw new Error(`Target "${path}" clashes with another target`)
    }
  }
}

/**
 * The `lstat` of a path below the project root, or undefined when it does not
 * exist. Refuses a symbolic link or junction in any component, since writing
 * or deleting through one could reach a file outside the project, and a
 * parent component that is not a directory.
 */
function pathStats(target, path) {
  const parts = path.split("/")
  let stats
  for (let i = 1; i <= parts.length; i += 1) {
    const shown = parts.slice(0, i).join("/")
    if (stats && !stats.isDirectory()) {
      throw new Error(`"${parts.slice(0, i - 1).join("/")}" is not a directory`)
    }
    try {
      stats = lstatSync(join(target, ...parts.slice(0, i)))
    } catch (error) {
      // Nothing exists from here on, so nothing can redirect the path.
      if (error.code === "ENOENT") return undefined
      throw error
    }
    // Node reports a Windows junction as a symbolic link too.
    if (stats.isSymbolicLink()) {
      throw new Error(`"${shown}" is a symbolic link; refusing to follow it`)
    }
  }
  return stats
}

/**
 * The content hashes a lock accepts for a file: one in a finished lock, the
 * old and the new one in a pending lock.
 */
function acceptedHashes(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** The temporary file `replaceFile` of this process writes for a path. */
function temporaryPath(path) {
  return `${path}.${process.pid}.tmp`
}

/**
 * Writes a file through a temporary file and a rename. The rename replaces
 * the directory entry, so a hard link at the destination keeps its other
 * file's content instead of being overwritten through the link.
 */
function replaceFile(absolute, content) {
  const temporary = temporaryPath(absolute)
  // `wx` fails on an existing file, which is then not ours to remove.
  writeFileSync(temporary, content, { flag: "wx" })
  try {
    renameSync(temporary, absolute)
  } catch (error) {
    // A leftover temporary file would block the next sync as a hand-made file.
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Refuses a path the sync cannot write, judged by the tree as it will be
 * after `removals`: a managed file may turn into a directory between releases
 * and back, but anything else in the way stops the sync before it changes
 * the project.
 */
function assertWritable(target, path, removals) {
  const parts = path.split("/")
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/")
    // A file about to be removed leaves nothing in the way.
    if (removals.has(prefix)) return
    const stats = pathStats(target, prefix)
    if (!stats) return
    if (i < parts.length) {
      if (!stats.isDirectory())
        throw new Error(`"${prefix}" is not a directory`)
    } else if (stats.isDirectory()) {
      const left = listEntries(target, prefix).filter(
        (entry) => !removals.has(entry.path)
      )
      if (left.length > 0)
        throw new Error(`"${path}" is a directory that is not empty`)
    } else if (!stats.isFile()) {
      throw new Error(`"${path}" is not a regular file`)
    }
  }
}

/** Removes the directories a removal left empty, up to a managed root. */
function pruneEmptyDirectories(target, path) {
  let dir = path.slice(0, path.lastIndexOf("/"))
  while (!MANAGED_ROOTS.includes(dir) && dir.includes("/")) {
    if (readdirSync(join(target, dir)).length > 0) return
    rmdirSync(join(target, dir))
    dir = dir.slice(0, dir.lastIndexOf("/"))
  }
}

/** The directories of a list that no other directory of the list contains. */
function outermost(directories) {
  const unique = [...new Set(directories)]
  return unique.filter(
    (dir) => !unique.some((other) => dir.startsWith(`${other}/`))
  )
}

/**
 * Reads the manifest and every managed file of the source at one release tag.
 * Contents come from the tagged commit, not from a working tree, so
 * uncommitted edits in a local checkout never reach a project.
 */
function readRelease(sourceDir, tag) {
  let commit
  try {
    // Only a tag pins a release; a branch would move under the lock. The tag
    // is looked up as an exact ref first, so a revision expression such as
    // `v1.0.0~1` cannot select another commit.
    git(sourceDir, ["check-ref-format", `refs/tags/${tag}`])
    const object = git(sourceDir, [
      "show-ref",
      "--verify",
      "--hash",
      `refs/tags/${tag}`,
    ])
      .toString()
      .trim()
    commit = git(sourceDir, ["rev-parse", "--verify", `${object}^{commit}`])
      .toString()
      .trim()
  } catch {
    throw new Error(`Tag "${tag}" not found in the source`)
  }
  const manifest = JSON.parse(
    git(sourceDir, ["show", `${commit}:manifest.json`]).toString()
  )
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schemaVersion ${manifest.schemaVersion}`
    )
  }
  assertManagedLayout(
    manifest.managedDirectories,
    Object.values(manifest.files)
  )
  assertNoClashes(Object.values(manifest.files))
  const files = {}
  for (const [source, target] of Object.entries(manifest.files)) {
    files[target] = git(sourceDir, ["show", `${commit}:${source}`])
  }
  return { commit, managedDirectories: manifest.managedDirectories, files }
}

/**
 * Every entry under a managed directory, as forward-slash paths relative to
 * `root`, with entries that are not regular files (links, sockets) marked.
 * Directories are walked by hand so that a linked directory is reported, not
 * followed.
 */
function listEntries(root, dir) {
  const entries = []
  const walk = (path) => {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true,
    })) {
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else entries.push({ path: child, regular: entry.isFile() })
    }
  }
  const stats = pathStats(root, dir)
  if (stats && !stats.isDirectory())
    throw new Error(`"${dir}" is not a directory`)
  if (stats) walk(dir)
  return entries
}

/** The lock of a project, or undefined before the first sync. */
function readLock(target) {
  const stats = pathStats(target, LOCK_FILE)
  if (!stats) return undefined
  if (!stats.isFile()) throw new Error(`"${LOCK_FILE}" is not a regular file`)
  const lockPath = join(target, LOCK_FILE)
  const lock = JSON.parse(readFileSync(lockPath, "utf8"))
  if (lock.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported lock schemaVersion ${lock.schemaVersion}`)
  }
  assertManagedLayout(lock.managedDirectories, [
    ...Object.keys(lock.files),
    ...(lock.temporaryFiles ?? []),
  ])
  return lock
}

/** Where the lock records the source: the remote URL rather than a local path. */
function repositoryName(source, sourceDir) {
  if (!existsSync(source)) return source
  try {
    return git(sourceDir, ["remote", "get-url", "origin"]).toString().trim()
  } catch {
    // A local checkout without a remote has no shareable name; keep the path.
    return source
  }
}

function sync(options) {
  if (!options.source || !options.ref) {
    throw new Error("sync needs --source and --ref")
  }
  const target = options.target ?? "."
  const previous = readLock(target)
  const source = openSource(options.source)
  try {
    const release = readRelease(source.dir, options.ref)
    const wanted = new Set(Object.keys(release.files))
    const previouslyManaged = new Set(Object.keys(previous?.files ?? {}))
    const previousTemporaries = new Set(
      previous?.pending ? (previous.temporaryFiles ?? []) : []
    )
    // Every check runs before the first deletion or write, so a refused sync
    // leaves the project as it was.
    // The previous and the new directories may nest; a set lists each file
    // once.
    const removals = new Set()
    const currentHashes = new Map()
    const directories = new Set([
      ...release.managedDirectories,
      ...(previous?.managedDirectories ?? []),
    ])
    // Walking only the outermost directories also lists a previous file
    // where the new release has a directory of that name.
    for (const dir of outermost([...directories])) {
      for (const entry of listEntries(target, dir)) {
        if (!entry.regular) {
          throw new Error(
            `"${entry.path}" is not a regular file; remove it by hand`
          )
        }
        // A sync killed between writing a temporary file and renaming it
        // leaves that file behind; its pending lock lists the exact names.
        if (previousTemporaries.has(entry.path)) {
          removals.add(entry.path)
          continue
        }
        // Only a file the previous release wrote is replaced or removed; any
        // other file there was put in by hand and may hold someone's work.
        if (!previouslyManaged.has(entry.path)) {
          throw new Error(
            `"${entry.path}" is not a file of a release; move it out by hand`
          )
        }
        // After an interrupted sync, a file is ours only with a content the
        // pending lock expected (as the sync found it, or the new release's);
        // anything else was written there by hand in between.
        const hash = contentHash(readFileSync(join(target, entry.path)))
        currentHashes.set(entry.path, hash)
        if (
          previous.pending &&
          !acceptedHashes(previous.files[entry.path]).includes(hash)
        ) {
          throw new Error(
            `"${entry.path}" changed after an interrupted sync; move it out by hand`
          )
        }
        if (!wanted.has(entry.path)) removals.add(entry.path)
      }
    }
    for (const path of [...wanted, LOCK_FILE])
      assertWritable(target, path, removals)

    // A pending lock names every file this sync may leave behind, so a sync
    // that fails halfway (a full disk, a file locked on Windows) can be rerun:
    // the next sync treats those files as its own, and check reports the
    // interrupted state instead of a match.
    const pending = {
      schemaVersion: SCHEMA_VERSION,
      pending: true,
      ref: options.ref,
      commit: release.commit,
      managedDirectories: outermost([...directories]),
      // Each file maps to the contents it may have when the sync stops: the
      // previous lock's, the one this sync found (a managed file edited by
      // hand is replaced, so its edit is expected too) and this release's.
      files: Object.fromEntries(
        [...new Set([...previouslyManaged, ...wanted])].map((path) => [
          path,
          [
            ...new Set([
              ...acceptedHashes(previous?.files[path]),
              ...(currentHashes.has(path) ? [currentHashes.get(path)] : []),
              ...(wanted.has(path) ? [contentHash(release.files[path])] : []),
            ]),
          ],
        ])
      ),
      // The temporary files `replaceFile` of this process may leave, and
      // those of an earlier interrupted sync not removed yet.
      temporaryFiles: [
        ...new Set([
          ...previousTemporaries,
          ...[...wanted].map((path) => temporaryPath(path)),
        ]),
      ],
    }
    mkdirSync(dirname(join(target, LOCK_FILE)), { recursive: true })
    replaceFile(
      join(target, LOCK_FILE),
      `${JSON.stringify(pending, null, 2)}\n`
    )

    for (const path of removals) {
      rmSync(join(target, path))
      pruneEmptyDirectories(target, path)
      console.log(`removed ${path}`)
    }
    const hashes = {}
    for (const [path, content] of Object.entries(release.files)) {
      // A directory left where the new release has a file holds no files
      // any more (assertWritable); only its empty directories remain.
      if (pathStats(target, path)?.isDirectory()) {
        rmSync(join(target, path), { recursive: true })
      }
      mkdirSync(dirname(join(target, path)), { recursive: true })
      replaceFile(join(target, path), content)
      hashes[path] = contentHash(content)
    }
    const lock = {
      schemaVersion: SCHEMA_VERSION,
      repository: repositoryName(options.source, source.dir),
      ref: options.ref,
      commit: release.commit,
      managedDirectories: release.managedDirectories,
      files: hashes,
    }
    replaceFile(join(target, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`)
    console.log(
      `synced ${wanted.size} files from ${options.ref} (${release.commit})`
    )
  } finally {
    source.close()
  }
}

/** Differences between the project's copy and the lock; empty when equal. */
function localProblems(target, lock) {
  const problems = []
  for (const [path, hash] of Object.entries(lock.files)) {
    const stats = pathStats(target, path)
    if (!stats) {
      problems.push(`missing ${path}`)
    } else if (!stats.isFile()) {
      problems.push(`not a regular file ${path}`)
    } else if (contentHash(readFileSync(join(target, path))) !== hash) {
      problems.push(`changed ${path}`)
    }
  }
  for (const dir of lock.managedDirectories) {
    for (const entry of listEntries(target, dir)) {
      if (!entry.regular) problems.push(`not a regular file ${entry.path}`)
      else if (!(entry.path in lock.files))
        problems.push(`unexpected ${entry.path}`)
    }
  }
  return problems
}

/** Differences between the lock and the release it names; empty when equal. */
function sourceProblems(source, lock) {
  const opened = openSource(source)
  try {
    const release = readRelease(opened.dir, lock.ref)
    const problems = []
    if (release.commit !== lock.commit) {
      problems.push(
        `${lock.ref} is ${release.commit}, the lock records ${lock.commit}`
      )
    }
    const sorted = (list) => JSON.stringify([...list].sort())
    if (
      sorted(release.managedDirectories) !== sorted(lock.managedDirectories)
    ) {
      problems.push(`managed directories differ from ${lock.ref}`)
    }
    const released = Object.fromEntries(
      Object.entries(release.files).map(([path, content]) => [
        path,
        contentHash(content),
      ])
    )
    for (const path of new Set([
      ...Object.keys(released),
      ...Object.keys(lock.files),
    ])) {
      if (released[path] !== lock.files[path]) {
        problems.push(`${path} differs from ${lock.ref}`)
      }
    }
    return problems
  } finally {
    opened.close()
  }
}

function check(options) {
  const target = options.target ?? "."
  const lock = readLock(target)
  if (!lock) {
    throw new Error(`${LOCK_FILE} not found; run sync first`)
  }
  if (lock.pending) {
    throw new Error(`An earlier sync of ${lock.ref} did not finish; rerun sync`)
  }
  const problems = localProblems(target, lock)
  if (options.source) {
    problems.push(...sourceProblems(options.source, lock))
  }
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) {
    console.error(
      `agent standards: ${problems.length} problem(s); rerun sync instead of editing`
    )
    process.exitCode = 1
    return
  }
  console.log(
    `agent standards: copy matches the lock (${lock.ref}, ${lock.commit})`
  )
  // Without a source the lock itself is not compared with the release.
  console.log(
    `source verification: ${options.source ? "PASS" : "NOT_RUN (no --source)"}`
  )
}

const [command, ...rest] = process.argv.slice(2)
try {
  const options = parseOptions(rest)
  if (command === "sync") sync(options)
  else if (command === "check") check(options)
  else
    throw new Error(
      "Usage: agent-standards.mjs sync|check [--source s] [--ref tag] [--target d]"
    )
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message)
  process.exitCode = 1
}
