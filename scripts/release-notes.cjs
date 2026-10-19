#!/usr/bin/env node
// Composes the GitHub Release notes (RELEASE-001e): the tester header that the release PR
// adds as docs/releases/vX.Y.Z.md, the version's generated changelog, and the artifacts with
// their checksums. release.yml runs it and fails without the header, so the draft carries the
// reviewed notes and nobody replaces them by hand (rule 02, section 5).
const fs = require('node:fs');
const path = require('node:path');

/** Path of the tester header for a release tag, relative to the repository root. */
function headerPath(tag) {
  return path.join('docs', 'releases', `${tag}.md`);
}

/**
 * Reads the tester header of a release.
 * @throws When the release PR did not add it, or it is empty.
 */
function readHeader(root, tag) {
  const file = path.join(root, headerPath(tag));
  if (!fs.existsSync(file)) {
    throw new Error(`${headerPath(tag).replace(/\\/g, '/')} is missing: the release PR adds the tester header (rule 02, section 5, step 9).`);
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) throw new Error(`${headerPath(tag).replace(/\\/g, '/')} is empty.`);
  return text;
}

/**
 * Joins the header, the generated changelog and the artifacts section.
 * @param parts - `header` and `changelog` (Markdown), `sums` (SHA256SUMS text), `tag`,
 * `repository` (`owner/repo`) and `sha` (the tagged commit).
 */
function composeNotes({ header, changelog, sums, tag, repository, sha }) {
  const version = tag.replace(/^v/, '');
  return [
    header.trim(),
    '',
    changelog.trim(),
    '',
    '## Artifacts',
    '',
    'Verify downloads against `SHA256SUMS` and their build provenance:',
    '',
    '```text',
    sums.trim(),
    '```',
    '',
    '```bash',
    'sha256sum --check --ignore-missing SHA256SUMS',
    `gh attestation verify coagent8-mcp-${version}.vsix --repo ${repository}`,
    `gh attestation verify coagent8-${version}.tgz --repo ${repository}`,
    '```',
    '',
    `Built by the Release workflow from \`${sha}\`.`,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!['--tag', '--changelog', '--sums', '--repository', '--sha', '--out'].includes(name) || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
    options[name.slice(2)] = value;
  }
  for (const required of ['tag', 'changelog', 'sums', 'repository', 'sha', 'out']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

function main(argv = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
  // `--check --tag vX.Y.Z` only requires the header, before the release workflow builds anything.
  if (argv[0] === '--check') {
    if (argv[1] !== '--tag' || !argv[2] || argv.length !== 3) throw new Error('Usage: release-notes.cjs --check --tag vX.Y.Z');
    readHeader(root, argv[2]);
    return;
  }
  const options = parseArgs(argv);
  const notes = composeNotes({
    header: readHeader(root, options.tag),
    changelog: fs.readFileSync(options.changelog, 'utf8'),
    sums: fs.readFileSync(options.sums, 'utf8'),
    tag: options.tag,
    repository: options.repository,
    sha: options.sha,
  });
  fs.writeFileSync(options.out, notes);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { headerPath, readHeader, composeNotes, main };
