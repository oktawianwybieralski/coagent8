# Code documentation

CoAgent uses TSDoc comments for TypeScript declarations, ESLint to validate their
syntax, and TypeDoc to generate a browsable source API reference. The reference
describes exported source modules for contributors; it does not promise a stable
public JavaScript API for the CLI package.

## Commands

For source-comment or documentation-tooling changes, run these commands from the
repository root. Ordinary Markdown prose edits require content/link review, not
API generation; see the [quality gate](../.agents/rules/04-quality-gate.md).

```bash
npm ci
npm ci --prefix tools/documentation
npm run lint:docs
npm run docs
```

The linter checks all TypeScript files under `src/` with `tsdoc/syntax` configured
as an error. TypeDoc expands `src/` into module entry points and writes HTML to
`.rc-artifacts/api-docs/index.html`. Generation fails on warnings, including broken
documentation links. CI runs both commands in every supported OS/Node matrix job.
Generated HTML is ignored by Git and excluded from the published package.

## Toolchain compatibility

The private `tools/documentation` tooling package pins TypeScript 6 because TypeDoc
and the ESLint TypeScript parser currently support its compiler API. The repository
root retains TypeScript 7 for `npm run typecheck`. The tooling package has its own
lockfile and dependency tree so transitive tooling dependencies also resolve a
compatible compiler. Install it with `npm ci --prefix tools/documentation`; do not
bypass peer dependency checks or replace the project compiler. Documentation tools
require Node 20.19+, Node 22.13+, or Node 24+; CI uses current Node 20/22 releases.

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

Avoid comments that only restate a function name or type. Syntax validation does
not prove documentation completeness or agreement with the implementation; review
behavioral claims against source code and tests. Keep cross-module design and
runtime contracts in [ARCHITECTURE.md](ARCHITECTURE.md) and
[RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md).

## References

- [TSDoc syntax and tags](https://tsdoc.org/)
- [TSDoc ESLint rule](https://tsdoc.org/pages/packages/eslint-plugin-tsdoc/)
- [TypeDoc module comments](https://typedoc.org/documents/Tags._packageDocumentation.html)
