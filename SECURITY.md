# Security Policy

## Supported versions

Before 1.0.0, security fixes target the newest published preview. Older previews
are not maintained separately; users should upgrade to the newest release.
Development builds from untagged commits are not supported releases, but reports
about vulnerabilities in the current source are welcome.

Support for stable release lines will be documented here when they become
available. See the [release history](https://github.com/oktawianwybieralski/coagent8/releases)
for published versions.

## Reporting a vulnerability

Use GitHub's private [Report a vulnerability form](https://github.com/oktawianwybieralski/coagent8/security/advisories/new).
Reports are shared with the repository maintainers rather than posted publicly.
Do not disclose vulnerability details in public issues, pull requests or
discussions. Ordinary bugs and usage questions can use
[GitHub Issues](https://github.com/oktawianwybieralski/coagent8/issues).

Include, where available:

- The affected CoAgent8 version and installation method (npm or VS Code).
- Your operating system, Node.js version, backend and backend CLI version.
- A description of the impact and any access or configuration needed to trigger it.
- Minimal reproduction steps or a proof of concept using synthetic data.
- Relevant, manually checked logs with credentials, private code and personal
  information removed.

Do not attach full configuration files, session archives or real credentials.
Automatic redaction does not replace checking the material yourself.
If the private form is unavailable, open an issue requesting a private security
contact without including vulnerability details.

## Handling and coordinated disclosure

The maintainer will assess the report, request clarification where needed and
coordinate the fix and public disclosure with the reporter through the private
report. This project does not guarantee response or resolution deadlines.

Please agree on a disclosure date with the maintainer before publishing exploit
details. Reporter credit can be included with the reporter's consent. Accepted
vulnerabilities and available fixes can be announced through
[GitHub Security Advisories](https://github.com/oktawianwybieralski/coagent8/security/advisories)
and release notes.

## Scope and current limitations

Relevant reports include bypasses of execution or approval policies, unintended
access across workspaces, disclosure of credentials or private session data, and
unsafe process or installation behavior in CoAgent8.

The current runtime is a local MCP-to-CLI bridge with read-only execution
profiles. It uses the user's installed coding CLIs and their authentication;
these CLIs can send task content to their model providers. Read-only filesystem
access does not imply that task content stays on the machine.

Backend protections differ. In particular, Antigravity inherits configured MCP
servers and plugins that CoAgent8 cannot disable. Process cleanup also has
documented platform limitations. Session records are stored locally even when
history archives are disabled. Review the
[backend profiles](README.md#backends-and-read-only-profiles) and
[known limitations](README.md#known-limitations) before using sensitive data.

For vulnerabilities solely in an upstream CLI or model provider, use that
vendor's security reporting channel. Report effects on CoAgent8's integration
here as well; uncertainty about the affected component should not prevent a
private report.
