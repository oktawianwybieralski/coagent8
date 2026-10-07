# CLI setup implementation handoff - 2026-10-07

This is a scoped context record and copyable prompt for the next coding agent.
[ROADMAP.md](ROADMAP.md#install-001--migration-001---optional-setup-and-presentation)
remains the single active plan. Read [AGENTS.md](../AGENTS.md), its linked rules,
and [the integration guide](VSCODE_INTEGRATION.md) before changing behavior.

**Correction (2026-10-07, `ANTIGRAVITY-HUB-001`):** statements below that the
Google extension supplies no `agy` describe only its VSIX contents. The
extension downloads and updates `agy` in `~/.gemini/bin` when it starts its
backend; CoAgent8 now discovers that copy, and onboarding offers the Google
extension as an installation method for Antigravity CLI.

## Established context

- The product is a client-independent stdio MCP bridge to local coding CLIs.
  VS Code integration and native-host MCP registration are optional.
- Current package version: `1.0.0-beta.2`, private testing only. No publication,
  release tag or release approval resulted from this session.
- Title: `CoAgent8 - MCP bridge to coding CLIs`. Author metadata:
  `Oktawian Wybieralski`; publisher ID: `okidev` (publisher name oki.dev).
  Extension identifier: `okidev.coagent8-mcp`. Do not restore the earlier IDs.
- Display CLI names in full: Codex CLI, Claude Code CLI, Antigravity CLI.
  Internal setup IDs remain `codex`, `claude`, `agy`; the runtime's Gemini backend
  uses Antigravity CLI. Preserve saved IDs and migration compatibility.
- The broken logo was removed from the VSIX Details README. The main extension
  icon remains, and Details has compact oki.dev / GitHub / Issues badges.
  The MCP runtime embeds light/dark logo variants independently of VSIX files.
  Installed Details badge rendering still needs confirmation.
- The owner removed standalone coding CLIs for clean-install testing, while
  explicitly preserving Codex, Claude Code and Antigravity extensions. Manual
  cleanup removed active CoAgent8 registrations/state and retained backups.
  That maintenance is not a production uninstall implementation. Preserve client
  histories, credentials, unrelated MCP servers and extensions in further tests.
- Uninstalling the VSIX did leave external MCP registrations and VS Code state.
  Restarting VS Code can refresh a live catalog, but does not remove persistent
  registrations. Explicit owned-registration cleanup is still required.
- Launching a bundled CLI creates or resumes the thread requested by the adapter;
  it does not attach automatically to the currently open VS Code conversation.
  A separate CLI thread can still appear in the client's shared history. Do not
  describe history visibility as active-chat synchronization or delete histories
  as part of installation/cleanup.

## Implemented baseline and evidence

Work is on local `fix/vsix-presentation`. Inspect the current tree and Git status
before continuing; do not replace this stacked branch with an older release
checkout or lose unmerged fixes. Latest implementation commit: `075e264`;
generated changelog commit: `cca00f2`.

- `src/execution/cli-resolver.ts` now discovers Codex and Claude binaries in
  standard `.vscode/extensions` and `.vscode-insiders/extensions` directories.
  PATH takes precedence over bundled discovery; configured executable overrides
  are authoritative. Fallback scans again and does not persist version folders.
  Codex uses the current platform/architecture subdirectory under `bin/`.
- `src/integrations/setup.ts` uses this shared resolver. Backend execution and
  setup therefore share bundled discovery. This is not yet discovery of every
  custom VS Code extension root, nor full compatibility validation.
- `extensions/vscode/src/extension.ts` lists all three clients with availability
  and editable remembered selections. Missing clients offer an official install
  command in a visible terminal. `sendText(command, false)` inserts the command;
  the user presses Enter. Installation, sign-in, reload and rerunning setup are
  currently manual. Missing clients are not registered.
- Current commands: npm global install for Codex, native PowerShell/bash
  installers for Claude and Antigravity. This is a command offer, not a completed
  managed installation or automatic post-install validation workflow.
- The old toast mentioning only standalone CLIs was replaced with one mentioning
  available and missing CLIs. Real installed-host UI acceptance remains pending.
- Local Windows probes found Codex CLI `0.162.0-alpha.2` in `openai.chatgpt` and
  Claude Code `2.1.292` in `anthropic.claude-code`. Both `--help` and `--version`
  succeeded. Empty-PATH discovery found both. The inspected
  `google.google-antigravity` extension did not contain a usable `agy` binary.
  These are local observations, not guarantees about future vendor packages.
- Typecheck, documentation lint/build, focused resolver/setup/provider/Codex/
  doctor/package regressions and isolated consumer smoke passed on Windows,
  Node `26.10.0`. Consumer smoke uses fixtures, not authenticated real backends.
- Private artifact: `.artifacts/coagent8-mcp-1.0.0-beta.2.vsix`, SHA-256
  `29e794c2a695147de323b358f91c77fd9c45758409871e60be5b0a1f644c1408`.
  Archive checks verified the new onboarding, runtime equality with the current
  build and the regenerated changelog. Any rebuild invalidates this artifact
  reference as evidence for the replacement.

## Implementation follow-up - 2026-10-07

The baseline above is historical. The follow-up implements separate CLI
onboarding/status, explicitly confirmed optional native-host registration, and
owned-registration preview/apply cleanup. The provider passes actual installed
vendor extension paths to shared runtime discovery, including custom roots;
paths are refreshed and never persisted as vendor executable overrides.
Metadata-only checks report CLI controls and Codex/Claude local sign-in separately
from direct-runtime/native-host calls. Antigravity sign-in stays unknown here.
Setup CLI code now ships in `dist/setup.cjs`, outside the core MCP bundle.

Cleanup verifies fingerprints and the current preview token, keeps private
backups, works without a backend CLI and retains runtime files, manual/edited
entries, credentials, histories and other extensions. Unsupported inline/dotted
Codex TOML remains a conflict. No production SQLite/profile-cache deletion or
uninstall hook is shipped. Local typecheck, source documentation checks, a fresh
build, 66 focused regressions and isolated package consumer smoke passed on
Windows / Node 26.10.0. The consumer also exercises bundled status/cleanup/help
without installed dependency resolution. Current private artifact evidence and
remaining acceptance are recorded in the INSTALL-001 / MIGRATION-001 section
of [ROADMAP.md](ROADMAP.md#install-001--migration-001---optional-setup-and-presentation).

Installed VS Code onboarding/Details rendering, actual sign-in, native Claude/agy
host calls and uninstall/restart residual-state acceptance remain pending. Do not
repeat maintenance on the owner's actual profile. No publication, tag, merge or
independent release approval resulted from the follow-up.

## Dependency recommendation

The owner permits proposing extension installation and justified dependencies;
the exact packaging choice is still open. Prefer requiring one working backend
over installing all providers for every user.

| Backend | Reuse first | Offer when missing |
| --- | --- | --- |
| Codex CLI | Explicit override, PATH, compatible binary from `openai.chatgpt` | Install the OpenAI extension or standalone Codex CLI, with a clear choice |
| Claude Code CLI | Explicit override, PATH, compatible binary from `anthropic.claude-code` | Install the Anthropic extension or standalone Claude Code CLI, with a clear choice |
| Antigravity CLI | Explicit override or standalone `agy` | Official standalone Antigravity CLI installer; the inspected extension is insufficient |

VS Code's [manifest reference](https://code.visualstudio.com/api/references/extension-manifest)
distinguishes `extensionDependencies` (functional extension dependencies) from
`extensionPack` (extensions installed together). A separate optional pack can
offer a convenient VS Code environment. Installing a pack is a choice to install
its contents, not an optional dependency declaration in the core extension.
Do not add unconditional dependencies on all three vendor extensions. In
particular, a Google extension dependency does not establish `agy` availability.

## Prompt for the next coding agent

Copy the following prompt into the new coding session, or tell the agent to read
this file and execute this section. Repository documentation and code stay in
English; communicate with the owner in Polish.

```text
Implement the remaining CoAgent8 clean-environment CLI onboarding and managed
registration cleanup work from docs/ROADMAP.md (INSTALL-001 / MIGRATION-001).
Read docs/CLI_SETUP_HANDOFF.md for the conversation context and tested baseline.
Read AGENTS.md, linked rules, docs/VSCODE_INTEGRATION.md and relevant runtime
contracts. Use Context7 for current VS Code and CLI documentation. Verify the
working tree, branch and current code before making changes; preserve the local
stack on fix/vsix-presentation and all unrelated changes. Follow the repository's
topic-branch/review workflow and do not push directly to release or main.

First give a concise assessment of what is already implemented, the remaining
gaps, and your recommended extension/CLI installation design. Then implement
the necessary work within this scope; do not stop at a plan. You may suggest
vendor extensions, offer their installation, and use a real functional dependency
where justified. Do not require all vendor extensions for core CoAgent8 use.
Keep any convenience extension pack separate and optional; do not publish it.

1. Preserve shared bundled discovery for Codex and Claude. Prefer explicit
   overrides, then existing PATH installations, then compatible bundled binaries.
   Extend discovery to actual installed extension paths/custom roots as needed,
   while keeping the standalone runtime independent of vscode APIs. Resolve
   again after extension updates/removal; never persist a vendor version path as
   a durable executable setting. A bad override fails closed for that backend
   and must not suppress the other backends' setup actions or diagnostics.

2. Require at least one compatible authenticated backend for useful execution.
   Show all three full CLI names and explain what is available or missing.
   For missing Codex/Claude, offer an appropriate vendor extension or standalone
   CLI. Verify that the installed extension actually supplies a compatible CLI.
   For Antigravity, use the official standalone agy installer: the inspected
   Google extension does not supply the required CLI. Refresh vendor docs and
   commands rather than assuming historical package layouts remain valid.
   Never silently download, install, sign in or run a paid model. Keep installer
   execution an explicit user action and handle cancellation/failure cleanly.

3. Finish the installation-to-ready flow. The current terminal command offer
   is already implemented; do not claim it completes installation. Provide a
   clear way to refresh discovery, verify versions/protocol capabilities, guide
   sign-in, report failures, and retry without duplicate registrations. Handle
   PATH refresh and extension reload requirements honestly. Metadata probes must
   be bounded, quiet on Windows and must not start billable model turns.
   Keep existing read-only sandbox and model-consent invariants intact.

4. Separate backend availability from optional native-host MCP registration.
   Installing/selecting a backend alone must not silently authorize registering
   CoAgent8 in that client's external configuration. Keep the ordinary VS Code
   MCP provider usable independently of native-host setup. Track CLI presence,
   protocol compatibility, authentication, registration, direct-runtime callability
   and native-host callability separately. Do not label a runtime doctor pass as
   a verified connection in Claude/Antigravity or an authenticated model response.

5. Implement explicit cleanup/uninstall for CoAgent8-owned external registrations
   with preview, private backups, fingerprint/conflict checks and idempotence.
   Remove only unchanged entries with recorded ownership; preserve manual or
   independently edited registrations, unrelated MCP servers, credentials,
   conversation history and third-party extensions/CLIs. Consider vscode:uninstall
   only as a best-effort supplement. A restart alone is not persistent cleanup.
   Handle legacy identities only with evidence of ownership. Investigate residual
   VS Code state/cache safely; do not copy the local maintenance SQLite scripts
   into production or mass-delete profile databases. Report partial failures and
   avoid deleting runtime files still referenced by preserved registrations.

6. Add meaningful isolated tests for no-CLI, bundled-only, standalone-only,
   one-backend-only and Antigravity-only environments; explicit override errors;
   custom extension paths; updates/removal; install cancellation/failure; repeated
   setup/repair; and cleanup preserving manual/edited entries. Exercise actual
   installed VS Code onboarding and native-host calls for any support claims.
   Preserve the owner's AI extensions; do not repeat destructive cleanup of the
   owner's real profile. Report unavailable interactive acceptance as pending.

7. Keep beta.2 and the established title, author, publisher okidev, full CLI labels,
   compact Details links and main extension icon. Do not reintroduce the broken
   Details logo. Update the existing roadmap and integration documentation with
   exact evidence. Use scope-appropriate checks; rebuild before dist-based tests,
   inspect the private VSIX and run consumer smoke when packaging changes. Generate
   CHANGELOG.md through git-cliff only, with its separate regeneration commit.
   Do not publish, create release tags, merge, or declare beta.2 release-ready.
   Existing audit/CI/release blockers still apply independently of this task.

Deliver the implementation, test/acceptance results, private artifact path/hash
when rebuilt, and a short account of remaining limitations. Follow independent
review requirements before any future merge; do not claim your own verification
is independent release approval.
```
