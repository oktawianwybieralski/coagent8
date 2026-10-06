# P2: Language & Code Style Standards (`06-language-and-style.md`)

> **Priority Level: P2 (Compatibility & Code Standards)**  
> Universal English-only policy for international open-source maintainability.

---

## 🌐 Universal English Standard

To maintain international open-source maintainability, clean CI automation, and seamless multi-agent collaboration across AI systems (Antigravity, Codex Sol, Claude Code), this repository enforces strict English language standards:

1. **Source Code & Identifiers**:
   - All variables, function names, classes, interfaces, types, enums, constants, and filenames must be strictly written in **English**.
   - No non-English or mixed-language identifiers are permitted under any circumstances.

2. **Code Comments & Docstrings**:
   - All inline comments, TSDoc comments, function descriptions, and TODOs must strictly be written in **English**.

3. **Status Messages & Progress Events**:
   - Live CLI progress updates, status event strings, diagnostic errors, and user-facing CLI messages must be emitted in **English** (e.g. `"Analyzing context and architecture..."`, `"Operation in progress..."`).

4. **Plans & Documentation**:
   - All project plans, architecture documents, specifications, roadmaps, and audits must be authored exclusively in **English**.

5. **Git Commits & Pull Requests**:
   - All Git commit messages must follow Conventional Commits in **English** (e.g. `feat(progress): implement safe live phase status`). The full commit, pull request and release conventions are defined in [02-git-workflow](02-git-workflow.md).
   - PR titles and descriptions must be authored in **English**.

## Naming and responsibility

Directory, module, class and function names define their responsibility. Behavior
and side effects must not exceed that scope. Delegate other responsibilities to
their named owner without duplicating its logic. Correct mismatches by moving or
splitting behavior, or precisely naming a coherent owner; generic names do not
justify unrelated work. Follow the ownership boundaries in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md#names-define-responsibility).

## TypeScript Documentation

Follow [`docs/CODE_DOCUMENTATION.md`](../../docs/CODE_DOCUMENTATION.md) for TSDoc
comments and TypeDoc module introductions. Document meaningful behavior and
contracts without duplicating TypeScript types. Run `npm run lint:docs` and
`npm run docs` when source comments or documentation tooling change, as specified
in [04-quality-gate.md](04-quality-gate.md). Ordinary Markdown edits do not need
these commands. Current CI still runs both checks. Syntax validation does not
replace reviewing comments against implementation.
