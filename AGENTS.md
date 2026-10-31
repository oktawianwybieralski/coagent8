# CoAgent8 - agent and contributor guidelines

Before starting any task, read:

1. [`.agents/project.md`](./.agents/project.md): the project parameters
   (branches, languages, primary sources, reviewers, standing go-aheads,
   commands).
2. Every file in [`.agents/rules/core/`](./.agents/rules/core/): the shared
   core rules from
   [agent-standards](https://github.com/oktawianwybieralski/agent-standards),
   pinned in [`.agents/standards.lock.json`](./.agents/standards.lock.json).
   They are copied verbatim and never edited here; `node
   .agents/standards/agent-standards.mjs check` verifies the copy.
3. The project rules below that apply to the task.

Precedence: the owner's instructions and the environment's limits, then the
core rules (P0 before P1 before P2), then the project rules and
`.agents/project.md`, then skills. A project rule may tighten a core rule; it
never relaxes one. When two requirements contradict each other, state the
conflict and stop the dependent work.

## Project and documents

Use [docs/ROADMAP.md](./docs/ROADMAP.md) as the single active plan,
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for contracts and design, and
[docs/HANDOFF.md](./docs/HANDOFF.md) for current work and evidence. These are the
three active project documents; optional ignored local notes are not instructions.
[docs/delivered/](./docs/delivered/README.md) is the permanent record of what each
version delivered, per card, with its evidence (owner decision 2026-10-20): history,
not instructions. The PR that delivers a card's subtasks adds or extends its record.

The product is a client-independent system for delegating complete tasks to
cooperating agents (owner decision, 2026-10-08). Roles and model/provider choices are independent;
client skill installation is planned. The current runtime is a read-only
MCP-to-CLI bridge except `delegate`, whose workspace-write profile follows
[rule 11](./.agents/rules/11-security-and-sandboxes.md) (owner decision
2026-10-21), until verified task execution profiles land. Follow the roadmap's
full coagent direction while preserving audit gates and quiet desktop
operation. Historical plans and RFCs do not override this direction.

## Project rules (`.agents/rules/`)

| Rule | Level | Scope |
| --- | --- | --- |
| [10 Architecture and runtime](./.agents/rules/10-architecture-and-runtime.md) | P0 | Runtime reliability, schema validation, synchronized metadata, dependency and responsibility boundaries |
| [11 Security and sandboxes](./.agents/rules/11-security-and-sandboxes.md) | P0 | Read-only profiles per backend, the `delegate` write profile, model cost governance and consent, secret redaction |
| [12 Release workflow](./.agents/rules/12-release-workflow.md) | P0 | `develop` and `X.Y.x` lines, commit and PR conventions, versioning, npm channels, the release process, changelog, issues, repository settings, history recovery |
| [13 Review](./.agents/rules/13-review.md) | P1 | The CoAgent8 review envelope and release candidate binding |
| [14 Quality gate](./.agents/rules/14-quality-gate.md) | P1 | Additional check scopes, the test runner, provenance of bundles and artifacts, the full release gate |
| [15 Cross-platform](./.agents/rules/15-cross-platform.md) | P2 | CI matrix, hidden Windows launches, process teardown, buffer bounds, Node 24 build |

Skills for contributors are in [`.agents/skills/`](./.agents/skills/).

### Earlier rule numbers

Documents and history written before 2026-10-31 cite the earlier rule files:

| Earlier | Now |
| --- | --- |
| 00 core invariants | core rule 00 and project rule 10 |
| 01 security and sandboxes | project rule 11 |
| 02 Git workflow | core rule 02 and project rule 12 (same section numbers) |
| 03 author and reviewer | core rule 03 and project rule 13 |
| 04 quality gate | core rule 04 and project rule 14 |
| 05 cross-platform | project rule 15 |
| 06 language and style | core rules 00 (keyboard characters) and 05 |
