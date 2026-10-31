# P0: Core invariants

Violations block review and merge. Project rules may add requirements; they
never relax these (README "Precedence").

## Authoritative sources and no guessing

- The primary sources for a framework or library are its official
  documentation, its official source repository at the tag or commit the
  project pins, and the installed public exports and types. Context7 or a
  documentation MCP server is a retrieval channel for those sources, not an
  independent compatibility guarantee. `.agents/project.md` names the primary
  sources of the project's stack.
- Before using an API, configuration option, hook or provider contract, read
  the relevant official documentation and verify it against the pinned
  version. Current documentation may describe a newer API. Record the source
  and version in the PR or in the architecture contract.
- Never implement "by eye", from model memory, an unverified snippet, an audit
  recommendation or agent consensus alone. Do not invent API names,
  signatures, defaults or behavior. Issues and discussions are investigation
  leads, not supported contracts.
- If documentation, source or audits disagree, state the conflict and check the
  pinned implementation. If the supported path remains unverified, mark it
  unverified and stop that implementation path; do not guess or bypass a guard.
  Independent work with verified inputs may continue.
- Distinguish documented behavior, source inspection, isolated probes,
  integration tests and end-to-end tests. None proves a stronger level of
  evidence than it is. Missing runtime evidence stays NOT_RUN until it runs.

## No hacks

- Fix the root cause. No temporary workarounds, monkey patches, mock bypasses
  in production code or "for now" branches without a roadmap card that removes
  them.
- No edits to installed packages, imports of private build output, copied
  framework internals or no-op replacements of framework validators. Do not
  suppress a framework error to make a demo work. An approved business
  requirement is not permission to bypass these rules.
- No silent error handling: never an empty `catch` without handling or a
  stated reason.
- No suppressed type errors: no `as any`, `@ts-ignore` or `@ts-expect-error`
  to hide a mismatch, and no build option that ignores type or lint errors.
  The typecheck passes with zero errors.
- Validate external input at the boundary: request bodies, responses of third
  parties and external CLIs, imported data.
- Do not work around the local environment inside the repository (wrapper
  scripts, shims, path hacks). Fix the environment or document the requirement
  in CONTRIBUTING.md.

## Upgradeability

- Our changes live in our own modules and in the supported extension points of
  the frameworks we use. Never modify installed packages or rely on private
  internals.
- Change upstream-owned files (starter, template or vendored code) only where
  no supported extension point exists, keep the change small and record it in
  ARCHITECTURE.md.
- Every custom behavior has tests that prove its contract, so an upgrade shows
  a break in tests, not in production.
- A design that would make upgrades risky needs an explicit owner decision
  before implementation.

## Keyboard characters only

Owner instruction, an absolute ban: no typographic characters that cannot be
typed on a standard keyboard. They are the usual marks of generated text and
break terminals, encodings and searches across Windows, Linux and macOS. The
ban covers everything we author: code, comments, UI strings, docs, rules,
configuration, tests, commit messages, PR titles and bodies, issues, and the
agent's messages to the owner.

- Forbidden: em and en dashes and other dash variants (U+2010 to U+2015,
  U+2E3A, U+2E3B), curly quotes and apostrophes (U+2018 to U+201F), guillemets
  (U+00AB, U+00BB, U+2039, U+203A), the ellipsis character (U+2026), arrows,
  bullets and middle dots used as punctuation, and non-breaking, thin or
  zero-width spaces. They are also forbidden as HTML entities, `\u` escapes
  and CSS escapes; `.agents/standards/check-keyboard-characters.mjs` checks
  every tracked file.
- Use `-`, straight `"` and `'`, backticks, `...` and the ordinary space.
  Letters of any language and currency symbols are not punctuation and stay
  allowed.
- Output that a runtime API formats (for example `Intl`) is not authored text;
  tests build expected values through the same API instead of typing those
  characters.
- Vendored third-party files stay byte-identical to their pinned source, but
  typography advice in them does not apply.

## Temporary code

Code that is meant to be replaced (demo data, a manual stand-in for a missing
integration) is allowed only when:

- it is isolated in its own file or function, named as temporary or demo,
- it never runs in production,
- a ROADMAP card names its removal.

## Fix procedure

Owner instruction, an iron rule: every fix of a defect, in our code or worked
around in a dependency, follows these steps in this order. A step that cannot
run is reported NOT_RUN with its reason; none is skipped silently and none is
replaced by a weaker kind of evidence. `.agents/project.md` may tighten a step;
it never removes one.

1. Current dependencies. Check whether a newer stable release of the affected
   dependency fixes the defect: read the release notes and the upstream issue.
   A defect is never patched on a release whose successor already fixes it;
   the update goes first, in its own PR.
2. Reproduce at the boundary where the defect shows: an HTTP request for a
   server, a protocol or CLI call for a tool, the browser for UI. Keep the
   failing output. A unit test with fakes alone does not reproduce a defect
   that crosses a boundary.
3. Fix the root cause through supported extension points (sections above).
4. Tests pass: a regression test that failed before the fix (the reproduction
   from step 2, kept in the repository) now passes, together with the checks
   rule 04 requires for the scope. It asserts the measured property, not a
   proxy for it.
5. Independent review of the exact head (rule 03). A confirmed P1 or P2
   finding goes through steps 2 to 4 again.
6. Verify again at the same boundary on the final head.

## Verifiable claims

- Never report a check, test or behavior as passing without having run it.
  Report NOT_RUN with the reason instead.
- Never delete, skip or weaken a test to make a suite pass. Tests define the
  contract.
- Documentation, package metadata and environment templates match the code in
  the same PR.
- Never state or imply that a push, merge, tag, release or deployment happened
  unless it was observed.

## Scope

- One coherent result per change. Do not expand the scope beyond the task;
  propose extra ideas in one sentence instead of implementing them.
- Remove dead code and unused dependencies you make obsolete in the same PR.
- A defect found in existing code outside the task is recorded (rule 02,
  "Findings"), not fixed silently inside an unrelated change.
