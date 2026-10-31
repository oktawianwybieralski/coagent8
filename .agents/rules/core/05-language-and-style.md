# P2: Language and style

## Language

- English for everything committed: identifiers, file names, comments, docs,
  rules, plans, audits, commit messages, PR titles and bodies, and local
  reports kept in ignored folders.
- UI text goes through the project's i18n with the languages
  `.agents/project.md` lists.
- Agents answer the owner in the conversation language `.agents/project.md`
  names, with keyboard characters only (rule 00).

## Formatting

- LF line endings (`.gitattributes`), UTF-8 without BOM.
- One formatter configuration for the repository; CI checks it. Every file
  stays formatted, so a change never carries layout edits of unrelated lines.
- A CI check rejects the characters forbidden by rule 00 in tracked files,
  except generated lockfiles and verbatim third-party files, each exclusion
  stated with its reason.

## Linting

- One lint policy for correctness and conventions. Warnings of the presets are
  errors in CI.
- No disable comment makes a new rule pass: fix the code, or narrow the rule's
  configuration with a comment that states why.

## Responsibility and names

- One file has one responsibility. A new capability goes into its own file
  unless it belongs to the responsibility of an existing file; free room in a
  file is never the reason to put it there. File and line counts are signals
  for review, and a size limit is a backstop, not the reason to split. Split
  an oversized file by responsibility, never by line ranges.
- Names of directories, modules, classes and functions state their
  responsibility, and their behavior stays inside it. No generic `utils`,
  `common` or `shared` dumping grounds for business logic.
- Upstream-owned files get only the integration point of our capability, so
  upstream diffs stay readable (rule 00, Upgradeability).

## Comments

- Comment why, not what. Exports carry documentation comments (TSDoc or the
  language's equivalent) that state the contract and the reason; a reason for
  a whole file is its leading comment; a reason for one line stays next to it.
- A comment names the source of its reason: an owner decision with its date,
  documentation or an upstream issue, a review finding, a measured cause.
- A behavior found while documenting is stated as it is, not changed in the
  same change; a defect goes to an issue (rule 02, "Findings").
- No commented-out code, no TODO without a ROADMAP card or an issue.
- Where tooling can check comments (documentation lint, generated API docs
  with warnings as errors), CI runs it and no suppression is accepted.
