/**
 * Full SemVer 2.0.0 parsing, precedence comparison, and dev-build classification.
 *
 * @packageDocumentation
 */

/** Parsed components of a Semantic Versioning 2.0.0 string. */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

/** Stable runtime pointer namespace: `current` for releases, `dev` for development builds. */
export type RuntimeNamespace = 'current' | 'dev';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENT = /^(?:0|[1-9]\d*)$/;

/**
 * Parses a SemVer 2.0.0 version string.
 *
 * @param version - Version string to parse.
 * @returns Parsed SemVer components, or `null` when invalid.
 */
export function parseSemver(version: string): ParsedSemver | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  // Numeric prerelease identifiers MUST NOT include leading zeroes (SemVer 2.0.0 section 9).
  for (const ident of prerelease) {
    if (/^\d+$/.test(ident) && !NUMERIC_IDENT.test(ident)) return null;
  }
  const build = match[5] ? match[5].split('.') : [];
  return { major, minor, patch, prerelease, build };
}

/**
 * Compares two SemVer 2.0.0 strings according to SemVer precedence rules.
 *
 * @remarks
 * Build metadata is ignored per SemVer 2.0.0 section 10. Pre-release versions have
 * lower precedence than the associated normal version.
 *
 * @param a - First version string.
 * @param b - Second version string.
 * @returns `1` when `a > b`, `-1` when `a < b`, `0` when equal precedence, or `null` if either is invalid.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const preA = pa.prerelease;
  const preB = pb.prerelease;
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;

  const limit = Math.max(preA.length, preB.length);
  for (let i = 0; i < limit; i++) {
    const idA = preA[i];
    const idB = preB[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;

    const numA = NUMERIC_IDENT.test(idA);
    const numB = NUMERIC_IDENT.test(idB);
    if (numA && numB) {
      // NUMERIC_IDENT forbids leading zeroes, so digit length then lexical order avoids Number precision loss above 2^53.
      if (idA.length !== idB.length) return idA.length > idB.length ? 1 : -1;
      if (idA !== idB) return idA > idB ? 1 : -1;
    } else if (numA !== numB) {
      // Numeric identifiers always have lower precedence than non-numeric identifiers.
      return numA ? -1 : 1;
    } else if (idA !== idB) {
      return idA > idB ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Whether semantic version `a` has strictly higher precedence than `b`.
 *
 * @param a - Candidate version string.
 * @param b - Incumbent version string.
 * @returns `true` when both parse as SemVer and `a > b`.
 */
export function newerVersion(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return compareSemver(a, b) === 1;
}

/**
 * Whether a SemVer string identifies a development build (prerelease or build tag starting with `dev`).
 *
 * @param version - SemVer version string.
 * @returns `true` when `version` is tagged as a development build.
 */
export function isDevSemver(version: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  if (parsed.prerelease.some(id => /^dev(?:$|-)/i.test(id))) return true;
  if (parsed.build.some(id => /^dev(?:$|-)/i.test(id))) return true;
  return false;
}
