#!/usr/bin/env node
// Composes the GitHub Release notes (RELEASE-001e): the "Release notes" section of the release
// PR's description, the version's generated changelog, and the artifacts with their checksums.
// release.yml runs it and fails without the section, so the draft carries the reviewed notes
// and nobody replaces them by hand (rule 12, section 5). No file in the repository holds them
// (owner decision 2026-11-05).
const fs = require('node:fs');

const SECTION = '## Release notes';

/**
 * Extracts the release notes from a release PR's description. They end at the next `##`
 * heading; their `###` subheadings become `##` in the release. Code fences are left alone.
 * @throws When the description has no such section, or it is empty.
 */
function extractNotes(body) {
  const notes = [];
  let found = false;
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (!found) {
      found = line.trim() === SECTION;
      continue;
    }
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) break;
    notes.push(!fenced && line.startsWith('### ') ? line.slice(1) : line);
  }
  if (!found) throw new Error(`The release PR's description has no "${SECTION}" section (rule 12, section 5, step 9).`);
  const text = notes.join('\n').trim();
  if (!text) throw new Error(`The "${SECTION}" section of the release PR is empty.`);
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
    const name = argv[i],
      value = argv[i + 1];
    if (!['--pr-body', '--tag', '--changelog', '--sums', '--repository', '--sha', '--out'].includes(name) || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${name}`);
    }
    options[name.slice(2)] = value;
  }
  for (const required of ['pr-body', 'tag', 'changelog', 'sums', 'repository', 'sha', 'out']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  // `--check --pr-body <file>` only requires the notes, before the release workflow builds anything.
  if (argv[0] === '--check') {
    if (argv[1] !== '--pr-body' || !argv[2] || argv.length !== 3) throw new Error('Usage: release-notes.cjs --check --pr-body <file>');
    extractNotes(fs.readFileSync(argv[2], 'utf8'));
    return;
  }
  const options = parseArgs(argv);
  const notes = composeNotes({
    header: extractNotes(fs.readFileSync(options['pr-body'], 'utf8')),
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

module.exports = { extractNotes, composeNotes, main };
