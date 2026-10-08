# CoAgent8 1.0.0-beta.2 - local release-note draft

This is an unpublished development candidate for invited testers. Local checks
do not establish independent review, supported CI acceptance or release approval.
The [roadmap](ROADMAP.md#beta-001---publish-100-beta2-and-100-beta3-to-invited-testers)
owns readiness. Generated change history is in [CHANGELOG](../CHANGELOG.md).

## What to test

Use CoAgent8 as a client-independent stdio MCP bridge to installed Codex,
Claude Code or Antigravity CLIs. Exercise consultations, reviews of current
workspace changes, continuation, cancellation, and sanitized diagnostics.
VS Code setup is optional; the private VSIX bundles the server and offers CLI
setup, configuration editing and explicit registration/cleanup actions.
Follow the [tester guide](../README.md#beta2-tester-guide).

## Security notes

- Codex disables inherited MCP servers and tool features, then verifies the
  thread before a turn starts. Unsupported verification fails closed. This was
  measured on Codex 0.162 only; older versions were not measured.
- Claude uses restricted Read/Glob/Grep tools, disabled hooks, an empty MCP
  configuration and dontAsk, verified at startup.
- agy uses its own native sandbox. agy 1.3.1 can still load user and plugin MCP
  tools; its sandbox does not isolate them. The owner accepted this third-party
  limitation on 2026-10-08. CoAgent8 refuses recursive backend turns and doctor
  names agy's inherited servers and plugins. Agent-shell language-server
  credentials and workspace-plugin loading in a conversation remain unmeasured.
- Required model approval belongs to the user, through MCP elicitation. A
  calling agent cannot approve a turn. Clients that cannot render the form can
  return POLICY_DENIED; this does not mean the user declined.
- Review input omissions, mismatched snapshots, failed checks and required
  unrun checks block READY. NOT_RUN is valid for prose-only checks. Review of a
  revision whose files differ from the current workspace is refused before a
  backend probe. A model verdict still requires independent evidence.
- Sandbox opt-out is planned for RC.1 in user configuration only. Beta.2
  provides no opt-out through configuration or tool arguments.

## Known limitations

The [runtime contract](RUNTIME_CONTRACT.md#7-known-limitations-and-deviations)
owns the detailed list. Remaining limitations include backend-only timeout
accounting, mandatory
session storage even with history off, and no first-turn handle before return.
Codex authentication is inferred; interactive approval and several native host
flows remain unverified. POSIX unexpected-parent-death cleanup remains open.
Other-revision tree review is
not available in this beta; use current workspace changes.

## Feedback

Use the issue tool to prepare a sanitized report, run doctor, and open the
repository's bug-report form. Include OS, Node, host and backend CLI versions,
reproduction steps, expected behavior and actual behavior. Report window/focus
changes on Windows as well as execution errors.
