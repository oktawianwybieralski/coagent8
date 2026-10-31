# P1: Quality gate

CI enforces the project's required checks on every PR. Locally, choose checks
by the scope of the change and report what you ran. Do not rerun the full gate
after every edit, commit or unchanged retry; for mixed changes use the union of
the affected scopes. The commands are in `.agents/project.md` and AGENTS.md.

## By scope

| Change | Required local evidence |
| --- | --- |
| Markdown, rules, plans | Content checked against the code, links valid, `git diff --check`, the character check. No typecheck, build or runtime tests for prose alone. |
| Code comments and documentation tooling | The documentation lint and generation the project defines; typecheck when executable code changed too. |
| Runtime logic, schemas, adapters, routes | Lint, typecheck, focused behavioral tests of the touched area (add them if missing). |
| Data models and migrations | As above, plus the migrations on a fresh database and on a copy of a realistic one. |
| Dependencies, build, packaging, env | Typecheck, build, and the application or package starting with the updated env template values. |
| CI and test harness | The workflow runs green on the PR; test discovery and selection still cover the suite. |

`.agents/project.md` may add scopes and checks; it never removes a row.

## Rules

- Never label an unexecuted check as PASS. Keep the complete failing output.
- A flaky test is a defect: find the cause, do not retry until green. An
  unexplained green retry is not a fix.
- A passing test is evidence only for the property it measures. A regression
  test asserts the measured property, not a proxy such as string presence.
- Static inspection is not a runtime reproduction, and a successful build does
  not prove runtime behavior.
- Lint warnings in code you touch are fixed in the same PR.
- Once the applicable checks pass, repeat or broaden them only for new
  changes, failures or unresolved risks.
- Agents keep their own scripts, logs and drafts in their session scratch
  directory or an ignored local folder, never in build or artifact output.
