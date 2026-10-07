# Code documentation

Documentation is split by responsibility: README for ordinary setup,
[architecture](ARCHITECTURE.md) for module boundaries,
[runtime contract](RUNTIME_CONTRACT.md) for implemented behavior,
[roadmap](ROADMAP.md) for proposals, and [snapshot reviews](PROJECT_REVIEW_2026-10-05.md)
for evidence. Contributor rules are normative even when an implementation gap is
recorded. Archives retain historical claims with their original scope.

CoAgent8 uses TSDoc comments for TypeScript declarations, ESLint to validate their
syntax, and TypeDoc to generate a browsable source API reference. The reference
describes exported source modules for contributors; it does not promise a stable
public JavaScript API for the CLI package.

## Commands

For source-comment or documentation-tooling changes, run these commands from the
repository root. Ordinary Markdown prose edits require content/link review, not
API generation; see the [quality gate](../.agents/rules/04-quality-gate.md).

```bash
npm ci
npm ci --prefix tooling/documentation
npm run lint:docs
npm run docs
```

The linter checks all TypeScript files under `src/` with `tsdoc/syntax` configured
as an error. TypeDoc expands `src/` into module entry points and writes HTML to
`.artifacts/api-docs/index.html`. Generation fails on warnings, including broken
documentation links. CI runs the linter in every supported OS/Node matrix job and
generates the documentation in the Ubuntu Node 24 job; the output does not depend
on the platform.
Generated HTML is ignored by Git and excluded from the published package.

## Toolchain compatibility

The private `tooling/documentation` tooling package pins TypeScript 6 because TypeDoc
and the ESLint TypeScript parser currently support its compiler API. The repository
root retains TypeScript 7 for `npm run typecheck`. The tooling package has its own
lockfile and dependency tree so transitive tooling dependencies also resolve a
compatible compiler. Install it with `npm ci --prefix tooling/documentation`; do not
bypass peer dependency checks or replace the project compiler. Documentation tools
declare Node 24+; full repository setup/build requires Node 24.11+ or Node 26+.
CI uses current Node 24/26 releases.

## Comment conventions

Write comments in English. Start with a short summary and use `@remarks` for
additional behavior or design constraints. Document meaningful contracts:

- Input constraints, units, defaults, and ownership requirements.
- Return values and errors callers must handle.
- Side effects, cancellation, concurrency, and resource lifetime.
- Examples for APIs whose correct use is not obvious.

Use `@param name - Description` without repeating TypeScript types. Describe type
parameters with `@typeParam T - Description`, return values with `@returns`, and
failure conditions with `@throws`. Use backticks for identifiers and literal data,
fenced code blocks for multiline examples, and `{@link Symbol}` for API links.

```ts
/**
 * Reads a bounded page of conversation events.
 *
 * @remarks
 * The cursor belongs to a single history revision. Start a new traversal if the
 * history changes between requests.
 *
 * @param handle - Session handle owned by the calling workspace.
 * @param limit - Maximum number of events, from 1 through 100.
 * @returns A page of events and an optional continuation cursor.
 * @throws If workspace ownership validation fails.
 */
```

Module introductions use `@packageDocumentation` before imports, following
TypeDoc's interpretation of this tag as a file/module comment. The TSDoc standard
itself defines the tag for a package entry point, so this repository's per-module
usage is a TypeDoc convention. Use `@remarks` for longer module introductions.

Avoid comments that only restate a function name or type. Types used in exported contract signatures must be represented in the reference;
export type-only contracts where appropriate. Do not suppress missing-reference
warnings or export runtime helpers solely to satisfy generation. Syntax validation does
not prove documentation completeness or agreement with the implementation; review
behavioral claims against source code and tests. Keep cross-module design and
runtime contracts in [ARCHITECTURE.md](ARCHITECTURE.md) and
[RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md).

## Model-facing descriptions and evidence

Tool/parameter descriptions and initialization instructions are runtime strings.
Changing them needs the focused surface/budget checks in addition to source-comment
lint/generation and typecheck. Do not promise universal catalog rejection, fresh
quota, session-free execution or sandbox capabilities that the code cannot prove.
The surface suite enforces the 512-character instructions and 5,300-byte definition
budgets; catalogs and actual model behavior remain backend-dependent.

Generated TSDoc output is not a user manual, security proof or release approval.
Record source-loaded checks separately from dist/tarball checks. The
[quality gate](../.agents/rules/04-quality-gate.md#source-bundle-and-artifact-provenance)
owns that distinction.

## Reconciliation evidence (2026-10-07)

The documentation candidate is based on `24052e3` with uncommitted changes.
Checks completed: `npm run lint:docs`, `npm run docs`, `npm run typecheck`,
`node tests/run.cjs tests/tools/surface.test.js` (15/15), local Markdown
path/anchor review and `git diff --check`. The focused suite loads source in a
hermetic fixture environment. Initialization instructions remain 482 characters;
two corrected descriptions bring model-visible definitions to 5,256 bytes.

API generation initially rejected four missing-reference warnings. Three types
used by exported signatures are now type-only exports; the private TTL reference
is plain text. Generation passes with warnings-as-errors still enabled.
No fresh dist build, full runtime suite, packaging or live backend call was needed
or run for this documentation task. Earlier build/artifact evidence remains bound
to its own snapshot in the project review. Generated HTML is local at
`.artifacts/api-docs/index.html`.

## References

- [TSDoc syntax and tags](https://tsdoc.org/)
- [TSDoc ESLint rule](https://tsdoc.org/pages/packages/eslint-plugin-tsdoc/)
- [TypeDoc module comments](https://typedoc.org/documents/Tags._packageDocumentation.html)
