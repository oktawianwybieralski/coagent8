# Changelog

All notable changes to CoAgent8 are documented in this file. It is generated
from the Conventional Commits history by [git-cliff](https://git-cliff.org/)
(`npm run changelog`); do not edit it by hand. Each entry starts with the commit
that introduced it.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Release procedure: [.agents/rules/02-git-workflow.md](.agents/rules/02-git-workflow.md).

## [Unreleased]

### Fixed
- [`d1d90a7`](https://github.com/oktawianwybieralski/coagent8/commit/d1d90a71f05b2f333f2cff4ac5401fe65f4b8cd5) **locks:** Report a budget-bounded lock wait as budget expiry ([#5](https://github.com/oktawianwybieralski/coagent8/pull/5))
- [`32fdb01`](https://github.com/oktawianwybieralski/coagent8/commit/32fdb01cdcac9a39d9e9e62f9ebd1ea4e9487269) **docs:** Render the mermaid diagrams and name the site CoAgent8 ([#6](https://github.com/oktawianwybieralski/coagent8/pull/6))
- [`809c3a0`](https://github.com/oktawianwybieralski/coagent8/commit/809c3a01ec31692e96f89bc63ed40d629015f921) **execution:** Report an expired call budget as TIMEOUT, not a cancellation ([#9](https://github.com/oktawianwybieralski/coagent8/pull/9))
- [`7a3d427`](https://github.com/oktawianwybieralski/coagent8/commit/7a3d42773a0d58606a9736479ba1f356405e5833) **doctor:** List a CLI in the models view as soon as it appears ([#10](https://github.com/oktawianwybieralski/coagent8/pull/10))
- [`d109069`](https://github.com/oktawianwybieralski/coagent8/commit/d1090696a33ed5ef42f468595c564b3a4b3f6d55) **review:** Name a change during the turn only when the input changed ([#11](https://github.com/oktawianwybieralski/coagent8/pull/11))
- [`cbf503a`](https://github.com/oktawianwybieralski/coagent8/commit/cbf503af2bab76b3c6cb002d80e12c42029e2c11) **sessions:** Say that a session is closed when a call or cancel uses it ([#12](https://github.com/oktawianwybieralski/coagent8/pull/12))
- [`08082ba`](https://github.com/oktawianwybieralski/coagent8/commit/08082ba0e6fd0dc6f2dcd4b897693dcd0c098a08) **sessions:** Scope paging parameters and retain handle on repeat review ([#24](https://github.com/oktawianwybieralski/coagent8/pull/24))
- [`e794f57`](https://github.com/oktawianwybieralski/coagent8/commit/e794f570ffac60608adef32c11f7f96fea59137a) **issue:** Format exact CLI versions, nest CLI list and clarify doctor attachment (FEEDBACK-060g)
- [`762cbf0`](https://github.com/oktawianwybieralski/coagent8/commit/762cbf0632dee72cf3e009339bc5c62a6cce5bb6) **issue:** Normalize CLI labels and versions to single lines in nested list

## [0.6.0] - 2026-10-11 ([`v0.6.0`](https://github.com/oktawianwybieralski/coagent8/tree/v0.6.0))

Entries link the commits of the 0.6.0 pull request (prepared as 1.0.0-beta.2),
which was squash-merged into `develop` as one commit (REPO-002). The pull request
page keeps them.

### Breaking
- [`d015035`](https://github.com/oktawianwybieralski/coagent8/commit/d0150354e9f2d8b88e59a122fe66cb769f93cce1) **execution:** Layered owned-process termination with protocol interrupts
- [`0edcdfa`](https://github.com/oktawianwybieralski/coagent8/commit/0edcdfaa79e7aab594bcf36b252137e77fba0cdc) Require Node.js 24 and test on Node 24 and 26
- [`77bef3e`](https://github.com/oktawianwybieralski/coagent8/commit/77bef3e1ea4bd86e6af8269ccf54003025e7733d) **mcp:** Remove the compact tool profile
- [`7d317f1`](https://github.com/oktawianwybieralski/coagent8/commit/7d317f1b7dc9045483a90ee48f958544870c7635) **errors:** Typed ToolError codes; unknown failures are PROCESS_ERROR
- [`a5c2cc7`](https://github.com/oktawianwybieralski/coagent8/commit/a5c2cc78dea11ede8016728d5dd3d006df3ac070) Stop tracking dist/ and check the packed bundle against a fresh build
- [`834dd87`](https://github.com/oktawianwybieralski/coagent8/commit/834dd87381261ebc53173bd89cf2fa4d63412e51) **sessions:** Scope MCP resources and session list to the workspace
- [`7c0de4f`](https://github.com/oktawianwybieralski/coagent8/commit/7c0de4f6a5e450a40eb0c07ae4d0edc6a6ab26ee) **policy:** Ask the user for top-tier models through MCP elicitation
- [`0a86007`](https://github.com/oktawianwybieralski/coagent8/commit/0a8600767efd85d64a2785a223dcc8077e362aea) **result:** Return execution results as markdown only
- [`3556c4c`](https://github.com/oktawianwybieralski/coagent8/commit/3556c4cd2c55a6dd1ef173dc81d964fe6c186adf) **models:** Take models and defaults from the CLIs and config.json, never from the source
- [`cd7d78f`](https://github.com/oktawianwybieralski/coagent8/commit/cd7d78f1e80fd0c2a7f8d7721e9664f515bfc5b9) **consent:** Ask the user by a model's approximate price, not by its name
- [`b79f744`](https://github.com/oktawianwybieralski/coagent8/commit/b79f7449f70ae5fd2c76d7b337347d79a62b4c04) **vscode:** One setup list, CLI executable choice and complete uninstall
- [`b2e483c`](https://github.com/oktawianwybieralski/coagent8/commit/b2e483cd37bdb617da0f43f3863773ea320bcd9a) **vscode:** Share ~/.coagent8/config.json with the CLI and keep it on uninstall
- [`0fe63f1`](https://github.com/oktawianwybieralski/coagent8/commit/0fe63f152caf3fda9dca7f5f6560b0b17f7a7a27) **doctor:** Default to a cached model view and move health to a scope

### Added
- [`94acde8`](https://github.com/oktawianwybieralski/coagent8/commit/94acde80943b951739409af15cdf376e81594782) **routing:** Choose another CLI than the client when auto is ambiguous
- [`c4da22c`](https://github.com/oktawianwybieralski/coagent8/commit/c4da22c63bdaf924ef64189a2164faeba81e1381) **doctor:** Summary by default, full detail, backend filter and quota switch
- [`7ac17f8`](https://github.com/oktawianwybieralski/coagent8/commit/7ac17f8407feb37572316e63d08dc55d099dfefc) **mcp:** Resolve the workspace from client roots and report it
- [`4b9307b`](https://github.com/oktawianwybieralski/coagent8/commit/4b9307bce0603fc932d3cb3de241bb5e51845ea1) **tools:** Say how to call CoAgent8 right on the first attempt
- [`047d232`](https://github.com/oktawianwybieralski/coagent8/commit/047d2325dbb625224e2734e23ccd896d1c711fa9) **branding:** Support dark themes and record MCP observations
- [`d2d29c7`](https://github.com/oktawianwybieralski/coagent8/commit/d2d29c7ecfbcb81e0f90486413db62493fb8db11) **setup:** Separate CLI readiness, host registration and cleanup
- [`42abbc8`](https://github.com/oktawianwybieralski/coagent8/commit/42abbc8321860c28c90a08cd2afd371ff55fc515) **execution:** Resolve agy from the Antigravity extension's copy
- [`366ad0a`](https://github.com/oktawianwybieralski/coagent8/commit/366ad0aab4fceb1e7f62fe174556046cab7434f8) **vscode:** Offer vendor extensions and await CLIs during onboarding
- [`74408da`](https://github.com/oktawianwybieralski/coagent8/commit/74408dabcd61b8f71ac8ebd5c5be3b33c0aa3bf0) **vscode:** Open configuration and persist welcome dismissal
- [`ac43699`](https://github.com/oktawianwybieralski/coagent8/commit/ac436994a5f3708233b41bb5f200ae4844a87ba7) **vscode:** Reset onboarding state through editor storage
- [`4bee717`](https://github.com/oktawianwybieralski/coagent8/commit/4bee71772769530c8b855e3553e1b6530cb05766) **vscode:** Expose backend, model and approval settings
- [`694fbf2`](https://github.com/oktawianwybieralski/coagent8/commit/694fbf282f3e98fbeb75a8ea07fb653c7acd9b2a) **vscode:** Remove extension registrations on uninstall
- [`42f249d`](https://github.com/oktawianwybieralski/coagent8/commit/42f249d0fdf9630b2daf7c22066f19850a10343f) **selection:** List model prices in doctor and enforce output price limits
- [`663e404`](https://github.com/oktawianwybieralski/coagent8/commit/663e404aee3fdc5a5f9c879461b5991937ff0c81) **claude:** Read Claude Code's model catalog from stream-json initialize
- [`acd7213`](https://github.com/oktawianwybieralski/coagent8/commit/acd721307090d0cf7e404b476d77e0c6b89ee080) **routing:** Route a named model to a backend that lists it
- [`dbc75c0`](https://github.com/oktawianwybieralski/coagent8/commit/dbc75c03b10d943d2fe3b924b455751df0ded5ed) **codex:** Read account rate limits from app-server
- [`38e45c0`](https://github.com/oktawianwybieralski/coagent8/commit/38e45c00c224424189114f5041f2fd2d060f87aa) **prices:** Keep per-model prices for offered models and refresh daily
- [`3f4ebaf`](https://github.com/oktawianwybieralski/coagent8/commit/3f4ebaf5db76cc1c2ea9400340b0efcd92929c54) **mcp:** Frame every answer in a markdown code block
- [`bf34e1f`](https://github.com/oktawianwybieralski/coagent8/commit/bf34e1fb1fcc8d2a71e8ab5642a3bee0de4afdfe) **mcp:** Present results raw for Codex and in plaintext frames elsewhere
- [`6c74973`](https://github.com/oktawianwybieralski/coagent8/commit/6c74973a8237004d1371396d046978d42a033d4d) **execution:** Implement phase timing and instrumentation (EXEC-001-T02)
- [`865e4b0`](https://github.com/oktawianwybieralski/coagent8/commit/865e4b0dbe5ad007e674ccfe553316f0aa54c455) **config:** Supply effective configuration with provenance (EXEC-001-T03)
- [`64d717d`](https://github.com/oktawianwybieralski/coagent8/commit/64d717d963b02d485a3b1d2ebe9f1b429bd20363) **execution:** Reuse observations within preparation (EXEC-001-T05)
- [`9d7aed1`](https://github.com/oktawianwybieralski/coagent8/commit/9d7aed1bee270233649e22ad8e9d41e12b11bba0) **execution:** Guarantee finalization after resource acquisition (EXEC-001-T06)
- [`1b1a246`](https://github.com/oktawianwybieralski/coagent8/commit/1b1a246497a0af138c4fe3f79805c11ca7150277) **execution:** Define complete-call budget contract (EXEC-001-T07)
- [`44b0002`](https://github.com/oktawianwybieralski/coagent8/commit/44b0002ddba390f27dd7b0603080acf941031334) **backends:** Define shared read and deadline context (EXEC-001-T08a)
- [`dba2ab6`](https://github.com/oktawianwybieralski/coagent8/commit/dba2ab6dbfec800b417235102153944e9a327bad) **backends:** Implement shared-read waiter ownership (EXEC-001-T08b)
- [`d9125f3`](https://github.com/oktawianwybieralski/coagent8/commit/d9125f33778ec5d39b852cc4ddf15c9720440681) **codex:** Bound probe, catalog, and quota reads (EXEC-001-T08c)
- [`ff18c49`](https://github.com/oktawianwybieralski/coagent8/commit/ff18c49064b6b66ec69cc36594c38a5e04aa9974) **claude:** Bound probe, catalog, and quota reads (EXEC-001-T08d)
- [`86249ae`](https://github.com/oktawianwybieralski/coagent8/commit/86249ae4c2aebb6021bf2338bb477207ed11f114) **agy:** Bound probe, catalog, quota, and tool reads (EXEC-001-T08e)
- [`f496263`](https://github.com/oktawianwybieralski/coagent8/commit/f4962637edf17a9fe741308a603811c5f4b408d3) **prices:** Bound price fetches and close shared-read races (EXEC-001-T08f)
- [`d429590`](https://github.com/oktawianwybieralski/coagent8/commit/d429590677f9e18bf97585b6b528d04010c49944) **review:** Bound review Git work and process lifecycle (EXEC-001-T09a)
- [`c8f5e50`](https://github.com/oktawianwybieralski/coagent8/commit/c8f5e505f017de9a305b6ba359fef4c93e3815a4) **storage:** Cancel lock waiters safely and preserve queue progress (EXEC-001-T09b)
- [`ec6819d`](https://github.com/oktawianwybieralski/coagent8/commit/ec6819d1297bba2d33a671cd73a48fd28bc19783) **sessions:** Stop session acquisition after expiry (EXEC-001-T09c)
- [`ef35b14`](https://github.com/oktawianwybieralski/coagent8/commit/ef35b149e920ed7868533e55daab26b3b319c98a) **consent:** Cancel pending approval and bind to deadline (EXEC-001-T10a)
- [`7a4fbd5`](https://github.com/oktawianwybieralski/coagent8/commit/7a4fbd5a1e94cf5c9da97a0bdf058a520573a885) **consent:** Revalidate policy and price evidence before acquisition (EXEC-001-T10b)
- [`4dcd660`](https://github.com/oktawianwybieralski/coagent8/commit/4dcd6601b9433a16cc5ac41988a87a4f62d7b965) **consent:** Preserve valid approvals across persistence failures (EXEC-001-T10c)
- [`38d12ad`](https://github.com/oktawianwybieralski/coagent8/commit/38d12ad960434da2af82588f382721b811bd3197) **execution:** Activate monotonic budget for consult and review (EXEC-001-T11a)
- [`9200c18`](https://github.com/oktawianwybieralski/coagent8/commit/9200c1860c79b16307c1be650cbeb5388cce36ed) **setup:** Install client skills with each registration (SKILLS-001)
- [`963803d`](https://github.com/oktawianwybieralski/coagent8/commit/963803d49f1e6da86a6a033d1cdddbc51765345b) **diagnostics:** Apply bounds and cancellation to doctor (EXEC-001-T11b)
- [`527f765`](https://github.com/oktawianwybieralski/coagent8/commit/527f765e2484f4a5856cab6e858d3c7bd06b0208) **execution:** Expose accurate timing and phase accounting (EXEC-001-T11c)
- [`2115b39`](https://github.com/oktawianwybieralski/coagent8/commit/2115b397b39cdd5d6d6874ab826a35e770a5a447) **review:** Say when another review cannot change the verdict (AX-007a)
- [`900c530`](https://github.com/oktawianwybieralski/coagent8/commit/900c530b2dab626c79b7f1595ee4b3ec75960f2f) **mcp:** Label the continuation handle in the result footer (AX-007b)
- [`9ddc3d1`](https://github.com/oktawianwybieralski/coagent8/commit/9ddc3d1db94af71a2ae5bccaeef273866efe12c3) **review:** Answer an unchanged repeat review without a model turn (AX-007c)
- [`2cc0b59`](https://github.com/oktawianwybieralski/coagent8/commit/2cc0b591ebbeaaa439460665977bd1573acc65b3) **skills:** Manage skill packages per client from VS Code and the CLI
- [`bfe1576`](https://github.com/oktawianwybieralski/coagent8/commit/bfe1576b147f1034f3e2063431775abf24cee399) **vscode:** Manage coding CLIs per client and leave extension removal to VS Code
- [`edf4b83`](https://github.com/oktawianwybieralski/coagent8/commit/edf4b830d5b354b1cd88dce759107f0512714ea7) **governance:** Allow, ask and deny model rules
- [`1f36525`](https://github.com/oktawianwybieralski/coagent8/commit/1f3652508eaa5fb0e391c61086663c4d1231b730) **vscode:** List CoAgent8 with the installed MCP servers
- [`d49cbf9`](https://github.com/oktawianwybieralski/coagent8/commit/d49cbf99efe653292638109e6d6fab39914b619f) **vscode:** Manage model approvals from one menu

### Changed
- [`1d2de9b`](https://github.com/oktawianwybieralski/coagent8/commit/1d2de9b7c9e20ed2c7f06c9aeda3a323f399fda9) **src:** Group backend files per CLI and split shared modules
- [`7451918`](https://github.com/oktawianwybieralski/coagent8/commit/74519184bc296c26955d99f5f7ab5e126b0a4df9) **src:** Place type definitions next to the modules that own them
- [`647c89b`](https://github.com/oktawianwybieralski/coagent8/commit/647c89bf0ec34dab07c924b859da419b069faf86) **src:** Import symbols from the modules that define them
- [`348d316`](https://github.com/oktawianwybieralski/coagent8/commit/348d316a819bedf52beebe6c2e79c1723d644db3) **src:** Delete dead code found by the audit
- [`4564685`](https://github.com/oktawianwybieralski/coagent8/commit/45646856dc69c1d7187ce415f88799ae65074911) **src:** Drop StreamReducer line framing and test-only collector API
- [`ac80f9b`](https://github.com/oktawianwybieralski/coagent8/commit/ac80f9bb689312c9fa9aab6abb420dd3b1f613cd) **src:** Stop exporting declarations used only in their own module
- [`dc255cb`](https://github.com/oktawianwybieralski/coagent8/commit/dc255cbec378ee8f37ed30b71914e2bcee026973) **build:** Bundle the MCP server with tsdown and ship license notices separately
- [`12622bb`](https://github.com/oktawianwybieralski/coagent8/commit/12622bb029953cc53fcddf891f1a14dcf8179722) **mcp:** One-sentence server instructions and compact tool definitions
- [`fc60fde`](https://github.com/oktawianwybieralski/coagent8/commit/fc60fdebab9405ec88c6fd0eafb2b9a8945643c8) **result:** Compact structured content, one-line footer and actionable consent errors
- [`665e5dd`](https://github.com/oktawianwybieralski/coagent8/commit/665e5ddd0d44e71938bbe2b00d59dbfe01b96177) **prompts:** Shorter review and consult prompts with a server-filled snapshot
- [`4691536`](https://github.com/oktawianwybieralski/coagent8/commit/4691536b3e2e586ba8d52989a1807f002b3fd747) **result:** Shorter footer with each line as its own quoted paragraph
- [`2dbedc7`](https://github.com/oktawianwybieralski/coagent8/commit/2dbedc7660101c7cae65d531748d13a43c9b8a59) **backends:** Reuse probes across requests and read agy quota only in doctor
- [`86ee98f`](https://github.com/oktawianwybieralski/coagent8/commit/86ee98fdfb5b54d02e92adefa0b92c7432b4f6b5) **gemini:** Keep only the runCommand deadline
- [`50992f1`](https://github.com/oktawianwybieralski/coagent8/commit/50992f114a9935f2c1eb4414b6ffcc08f9e55f30) **startup:** Inject background maintenance instead of environment test hooks
- [`702d52e`](https://github.com/oktawianwybieralski/coagent8/commit/702d52ee253f2c4463b7f85d9464da1653f4a78b) **tools:** Map the deprecated tools and run actions through one alias table
- [`5eaf407`](https://github.com/oktawianwybieralski/coagent8/commit/5eaf4070397e15ec0caeed7d9804f73baaaea101) **backends:** One structured-error extractor parameterized per backend
- [`20dc0b4`](https://github.com/oktawianwybieralski/coagent8/commit/20dc0b49896dc8bcfb6e090497090d8b61126114) **progress:** Redact each progress message once, where it leaves for the client
- [`2255f1a`](https://github.com/oktawianwybieralski/coagent8/commit/2255f1af5fd470ae4ca9f33767f931681cb8cb50) **probes:** Share concurrent probe, catalog and model reads
- [`3c2344f`](https://github.com/oktawianwybieralski/coagent8/commit/3c2344f3b868bb6e2d118a63f88699b48ab97760) **modules:** Extract contracts, storage, workspace and runtime
- [`cc6e53d`](https://github.com/oktawianwybieralski/coagent8/commit/cc6e53dcf09fb2c67e0fe3c35ef2ed001dd18a18) **mcp:** Separate execution from MCP presentation (S2)
- [`5660c5d`](https://github.com/oktawianwybieralski/coagent8/commit/5660c5dd150d13fb312b9a670b03baf6db5d69c9) **models:** Separate model policy from provider discovery (S3)
- [`fc39a44`](https://github.com/oktawianwybieralski/coagent8/commit/fc39a444b97f1040b098dcc9f0fdad100ab38188) **sessions:** Split history by responsibility and extract credential boundaries (S4)
- [`5f8c210`](https://github.com/oktawianwybieralski/coagent8/commit/5f8c2105e092f2c657db2922eb79175facf6e379) **layout:** Finish consumers, mirror test layout, and retire internal shims (S5)
- [`9f6ce57`](https://github.com/oktawianwybieralski/coagent8/commit/9f6ce57fff1f482e062a4646dc7c211158ffaa1f) **boundaries:** Enforce automated dependency boundaries and cycle detection (S6)
- [`403557a`](https://github.com/oktawianwybieralski/coagent8/commit/403557af25f51818c5d6bd8dd1e194faf84670df) **execution:** Establish reproducible baseline and call map (EXEC-001-T01)
- [`217f443`](https://github.com/oktawianwybieralski/coagent8/commit/217f443ee0721003ad34780cd894233e8ebd95c6) **execution:** Extract cohesive task preparation (EXEC-001-T04)

### Fixed
- [`ddc3a4e`](https://github.com/oktawianwybieralski/coagent8/commit/ddc3a4e0e97774b007bc97837da44b74568ca513) **execution:** Enforce process identity and safe teardown on Windows
- [`e186711`](https://github.com/oktawianwybieralski/coagent8/commit/e1867116ff6a012c6a473b743d1c991beaf9e501) **execution:** Optimize process polling and align consumer package verification
- [`3153f64`](https://github.com/oktawianwybieralski/coagent8/commit/3153f64cf99c3f9f6837c72857b1f390e63ac46d) **gemini:** Give agy a 2 s SIGTERM grace on POSIX
- [`033d359`](https://github.com/oktawianwybieralski/coagent8/commit/033d3597ca71b21d6305d3f34882d98b4a0a4bd2) **redaction:** Split credential format from diagnostic redaction
- [`a2bff80`](https://github.com/oktawianwybieralski/coagent8/commit/a2bff80f361125da2bf9e419c70d9b403a964d71) **build:** Order license notices independently of the build locale
- [`9123f62`](https://github.com/oktawianwybieralski/coagent8/commit/9123f6268278ed76ba8e3585c699223052413f39) **history:** Append-only streaming deltas with credential tail buffering
- [`249f91a`](https://github.com/oktawianwybieralski/coagent8/commit/249f91ac8aa68306ff95edd4d7ad74580779a43a) **controller:** Isolate CLI execution from archive and session bookkeeping
- [`485adaa`](https://github.com/oktawianwybieralski/coagent8/commit/485adaa0ceb5fa2231f4dec1b47ec00286827b5c) **history:** Address Opus review findings on tail buffering, capacity locking, and cooldowns
- [`5854021`](https://github.com/oktawianwybieralski/coagent8/commit/5854021763cbdcd19c7ba2fc163b1e0a367efd17) **history:** Address lock ordering, AWS key tail buffering, and capacity accounting
- [`24caab5`](https://github.com/oktawianwybieralski/coagent8/commit/24caab5f273651033198e0966922516491698369) **history:** Restore JWT and Slack prefix checks and decouple append from capacity lock
- [`4c45d1e`](https://github.com/oktawianwybieralski/coagent8/commit/4c45d1ee09d13ea67b282b63cdb77657108a35bc) **history:** Safely catch rollback lock errors to guarantee original io error propagation
- [`6a65538`](https://github.com/oktawianwybieralski/coagent8/commit/6a6553872c480f46b7b3e5a81f5c26873f92e23b) **backends:** Report the model each backend resolved
- [`62d0f3a`](https://github.com/oktawianwybieralski/coagent8/commit/62d0f3a12bcf536147e0f7dad1d290a8a9a1e516) **gemini:** Keep the answer when the sandbox denies an action
- [`0df32e4`](https://github.com/oktawianwybieralski/coagent8/commit/0df32e4f1e0c1ad2eb1547ea251670af86023fe0) **setup:** Raise the Codex tool timeout for CoAgent8 to 30 minutes
- [`6837fec`](https://github.com/oktawianwybieralski/coagent8/commit/6837fec203979184e9ac103120d834f344ab6134) **routing:** Record one cooldown per rate-limited turn with the parsed reset
- [`b7c37f0`](https://github.com/oktawianwybieralski/coagent8/commit/b7c37f075db4a95f413745e15875f063c9fbc64d) **codex:** Read the default model from config.toml with a TOML parser
- [`66df69d`](https://github.com/oktawianwybieralski/coagent8/commit/66df69dfd097b004f0c0cade87cd2a924aaf3ddf) **backends:** Reject option-like model identifiers before they reach a CLI
- [`6b419af`](https://github.com/oktawianwybieralski/coagent8/commit/6b419af8737a57e53f3032cc3605ae94b3d5f4cf) **gemini:** Ignore unknown agy event types with a warning
- [`4afc7f2`](https://github.com/oktawianwybieralski/coagent8/commit/4afc7f277923fd246aecb220d7dd28ddd56f2f28) **locks:** Publish leases atomically, renew them and reclaim stale ones by age
- [`5da124e`](https://github.com/oktawianwybieralski/coagent8/commit/5da124e55a051e50444fdd8f31d7606491249817) **backends:** Classify CLI errors by anchored phrases and parse ms and decimal resets
- [`a9ccc36`](https://github.com/oktawianwybieralski/coagent8/commit/a9ccc36084e9dd488e07553472f3b790248af2ce) **gemini:** Treat a usage window without remaining_fraction as unmeasured
- [`cd2e6c5`](https://github.com/oktawianwybieralski/coagent8/commit/cd2e6c510547aeef58960eb2d437f4d614a69132) **errors:** Remove dead catches and report the failures that were ignored
- [`344ed39`](https://github.com/oktawianwybieralski/coagent8/commit/344ed39956a16431af26199d6e22be63f619ce3b) **config:** Report an unusable configuration in doctor and refuse execution
- [`3efaa52`](https://github.com/oktawianwybieralski/coagent8/commit/3efaa521abfe28a4d21ee2db60f0d6b3378c1ef5) **history:** Replace empty catches with explicit absence and cache handling
- [`ae86532`](https://github.com/oktawianwybieralski/coagent8/commit/ae865328dd38b5f58e39f926a6e3fb4e6049aad6) **mcp:** Stop declaring resource list notifications that are never sent
- [`92206d9`](https://github.com/oktawianwybieralski/coagent8/commit/92206d95e691b5ac6a96276d6c34f51fe9397e8c) **process:** Report POSIX group signal failures and skip the grace for an exited group
- [`d851b14`](https://github.com/oktawianwybieralski/coagent8/commit/d851b143e4a455dcf4c5689468d00c910f0463c1) **result:** Keep answer lines that quote npm notices or update banners
- [`7f36f5b`](https://github.com/oktawianwybieralski/coagent8/commit/7f36f5b46aa47229e4d2bc44f5edea49303de598) **session:** Report cancelled only when a running turn was stopped or released
- [`3024372`](https://github.com/oktawianwybieralski/coagent8/commit/302437230094794d6789777d1abf445650805a49) **session:** Show workspace paths under the home directory as ~ in session lists
- [`6eef2f4`](https://github.com/oktawianwybieralski/coagent8/commit/6eef2f46b5079f952680ba3fa9634ec46218a7e7) **errors:** Type rejected models and drop the invented answer of a failed run
- [`20fc305`](https://github.com/oktawianwybieralski/coagent8/commit/20fc30536b0fbbbe319cae22388f8a9c9c19af13) **models:** Check model and effort against the catalog the CLI reports
- [`d96dae7`](https://github.com/oktawianwybieralski/coagent8/commit/d96dae7194eda8b8addece68466059449ce3f828) **codex:** Return the final answer without the turn's commentary
- [`a87ede3`](https://github.com/oktawianwybieralski/coagent8/commit/a87ede3c2f6b1fefc5313bef718599398e075eb1) **consult:** Pass a plain question on as asked
- [`34bad59`](https://github.com/oktawianwybieralski/coagent8/commit/34bad599829bfaa806461e8e62440d1e1e2a9cda) **result:** Name the requested model in the footer of a refused call
- [`2308f03`](https://github.com/oktawianwybieralski/coagent8/commit/2308f03cd9dfcdef9398530dc0db4c57e7a6b82c) **consent:** Accept only an explicit approve: true as the user's consent
- [`031715b`](https://github.com/oktawianwybieralski/coagent8/commit/031715b3937fb102087166c961fc6304c52ea35a) **session:** Keep the session's reasoning effort on a continuation
- [`f83b73f`](https://github.com/oktawianwybieralski/coagent8/commit/f83b73f6c914cbd274f0a6ef254b534c7cd10a31) **gemini:** Disable agy's auto-updater, whose console window takes the focus
- [`1bf9ae0`](https://github.com/oktawianwybieralski/coagent8/commit/1bf9ae09260877c35c9b240c124fb73dbf26fbff) **consent:** Report a cancelled approval request as unanswered, not declined
- [`52c1da0`](https://github.com/oktawianwybieralski/coagent8/commit/52c1da09488ec858c04861887a19db39c28b171a) **vscode:** Clarify CLI names and embed private preview logo
- [`8393cc3`](https://github.com/oktawianwybieralski/coagent8/commit/8393cc326c8fda9b71139c70dff90e91310be84f) **vscode:** Use the new okidev publisher
- [`6b6ec27`](https://github.com/oktawianwybieralski/coagent8/commit/6b6ec270b5375f847bbd63c2268afdea93d6d79a) **vscode:** Replace broken Details logo with compact links
- [`6569fe2`](https://github.com/oktawianwybieralski/coagent8/commit/6569fe2f086d8bf2bbbcd3a04dc364e34d352f78) **vscode:** Discover bundled Codex and offer CLI installation
- [`1665b59`](https://github.com/oktawianwybieralski/coagent8/commit/1665b59ef924b7d07db06033647884ef60ee3a7b) **setup:** Preserve CLI evidence and verify owned cleanup
- [`caf580e`](https://github.com/oktawianwybieralski/coagent8/commit/caf580e8036625cbbe5424ca8a445f4203a5d907) **setup:** Read CLI help from stderr as well as stdout
- [`94f90f8`](https://github.com/oktawianwybieralski/coagent8/commit/94f90f874ac88d5bc770ce0eab4a89132c095670) **vscode:** Keep the CLI picker open while setup checks run
- [`1547c92`](https://github.com/oktawianwybieralski/coagent8/commit/1547c921e7981e30c773fedae67644e216d6963a) **setup:** Detect Antigravity CLI sign-in with its silent check
- [`91459c5`](https://github.com/oktawianwybieralski/coagent8/commit/91459c53d630172fccb9ccccf99cc2cfb78eb258) **setup:** Report unregistered CLIs clearly and log one line per check
- [`edee627`](https://github.com/oktawianwybieralski/coagent8/commit/edee6272cd03a50f8efffc07185e4b013dc0f336) **adapters:** Disable and verify inherited Codex MCP servers per thread
- [`bbbfc51`](https://github.com/oktawianwybieralski/coagent8/commit/bbbfc51bb5405bed37aadd943bf9fb9b64f5362a) **adapters:** Refuse recursive turns and name agy's inherited tools
- [`f2b86e5`](https://github.com/oktawianwybieralski/coagent8/commit/f2b86e5fe2ba3ebf3418ba65d420e801f6dd03a7) **review:** Bind verdicts to complete current workspace input
- [`813d5f3`](https://github.com/oktawianwybieralski/coagent8/commit/813d5f3b65d6b46a8e2ee65c2976f874185121db) **vscode:** Bind configuration and refresh MCP definitions
- [`1ab472f`](https://github.com/oktawianwybieralski/coagent8/commit/1ab472f3aa16aa253a8bd2a831eaf93cda7d7050) **vscode:** Keep extension data in storage removed on uninstall
- [`7a3213d`](https://github.com/oktawianwybieralski/coagent8/commit/7a3213ddbc6734f0a6e8e04b643ce2d47f379e0b) **routing:** Keep auto selection working without a writable quota cache
- [`1bc530d`](https://github.com/oktawianwybieralski/coagent8/commit/1bc530d9e5a815ee95d64096da09b62e7525772e) **codex:** Keep a complete final answer untruncated after dropped commentary
- [`16b4e48`](https://github.com/oktawianwybieralski/coagent8/commit/16b4e48f1e98cbd33238670a6ddbdf8f411c99f5) **history:** Reserve snapshot bytes before writing them
- [`27e3914`](https://github.com/oktawianwybieralski/coagent8/commit/27e391416875e3d055e6b1260d68262832a33f7b) **history:** Cut fragments at UTF-8 character boundaries
- [`8d8f4f2`](https://github.com/oktawianwybieralski/coagent8/commit/8d8f4f25adb5709b1a8711ee586e4c37fe277039) **prices:** Let shutdown wait for a background price read
- [`e1b0db1`](https://github.com/oktawianwybieralski/coagent8/commit/e1b0db146ed34cf13d1e774ec74c204cbd680ab5) **backends:** Stop reporting a complete answer as truncated
- [`436f1e3`](https://github.com/oktawianwybieralski/coagent8/commit/436f1e3943c2206e5491337350e1bacc973d7a43) **review:** Show the reviewer answer verbatim and report every block cause
- [`a109cc2`](https://github.com/oktawianwybieralski/coagent8/commit/a109cc2dea507176bb763498474727f86c6a69a7) **agy:** Report a turn ended by a sandbox denial as a failure
- [`132cb3d`](https://github.com/oktawianwybieralski/coagent8/commit/132cb3d64e4ed462303869106a230fed8be931b1) **setup:** Update owned Claude and agy registrations to the new runtime
- [`c5e040f`](https://github.com/oktawianwybieralski/coagent8/commit/c5e040f53b061e6b363d52a4d637e71bdf293902) **boundaries:** Reject SDK and indirect transport dependencies
- [`dc87cdd`](https://github.com/oktawianwybieralski/coagent8/commit/dc87cdd7e08573398264bce3b03e6e66e6678990) **tests:** Bound concurrency barrier and ensure guaranteed task settlement
- [`657be85`](https://github.com/oktawianwybieralski/coagent8/commit/657be8540200e467d6cde6e2f1f6a483ad2f7ed9) **tests:** Bound child readiness and teardown in lock contention test (EXEC-001-T09b)
- [`32acb59`](https://github.com/oktawianwybieralski/coagent8/commit/32acb59288455f3b1f83ff6fdcf9a2852de79709) **diagnostics:** Preserve prefilled issue links in chat clients
- [`d8645d0`](https://github.com/oktawianwybieralski/coagent8/commit/d8645d0c5842335df4210d1fa54a4883b7fa813f) **quota:** Keep other providers when the cache cannot be read (AUDIT-001-A01-A03)
- [`7666cd4`](https://github.com/oktawianwybieralski/coagent8/commit/7666cd4809c7505ad4ea2c183b996759cf92918f) **config:** Serialize saveConfig under the configuration lease (AUDIT-001-A04-A05)
- [`dfd0c37`](https://github.com/oktawianwybieralski/coagent8/commit/dfd0c37194df84ce10d3e7fc5227391619a263e6) **config:** Write configuration through the shared atomic writer (AUDIT-001-A06-A07)
- [`71ae03d`](https://github.com/oktawianwybieralski/coagent8/commit/71ae03ddfe83ab195824e216a14655b4a4383e74) **setup:** Recognize own registrations when the ownership record is lost
- [`f8c2733`](https://github.com/oktawianwybieralski/coagent8/commit/f8c27330d5c4f87b1fb7e75974196ceccdb52ade) **vscode:** End the uninstall with Restart Extensions instead of quitting VS Code
- [`2c1ff4f`](https://github.com/oktawianwybieralski/coagent8/commit/2c1ff4fb3dfd41086354f4e0a907c4002a26b0b7) **setup:** Compare CLI sources by their real path
- [`79cc5f6`](https://github.com/oktawianwybieralski/coagent8/commit/79cc5f62d244f0d1104103e4b394dc0726ac6e29) **vscode:** Offer vendor extensions over standalone CLIs and remove standalone installs completely
- [`78b1bd5`](https://github.com/oktawianwybieralski/coagent8/commit/78b1bd533919f2d8802051bd7ad0d476d72d616b) **setup:** Offer installation when a selected vendor extension copy is missing
- [`f10166e`](https://github.com/oktawianwybieralski/coagent8/commit/f10166eac1642711e2f83b8a191ca67ace4151c0) **vscode:** End the uninstall with Reload Window to apply extension removals
- [`80d0e61`](https://github.com/oktawianwybieralski/coagent8/commit/80d0e616815ec655df7e2bd0881dd6025a832598) **vscode:** Keep an edited profile entry the user's when its runtime path is unchanged
- [`b33acd4`](https://github.com/oktawianwybieralski/coagent8/commit/b33acd43599220bcb28cc376153595f53396c705) **review:** Let reviewers without file tools read files with read-only commands
- [`527ab7d`](https://github.com/oktawianwybieralski/coagent8/commit/527ab7df9a28dff8aee183c7983451dee2c8ad0d) **vscode:** Record a pending digest so a rewrite never takes a racing user edit
- [`6af6c80`](https://github.com/oktawianwybieralski/coagent8/commit/6af6c80e5d58ba92ff39e7d151c9204fe5ae4f75) **governance:** Apply model rules to the effort variant a turn runs
- [`ba442a5`](https://github.com/oktawianwybieralski/coagent8/commit/ba442a51006d81863201c18a4c9b746e3ad22592) **review:** Stop blocking a read-only review on checks it cannot run
- [`2cd1071`](https://github.com/oktawianwybieralski/coagent8/commit/2cd1071806f8241a59e80bb34d15f071eea70882) **vscode:** Add no profile entry beside a workspace CoAgent8 registration
- [`30e7737`](https://github.com/oktawianwybieralski/coagent8/commit/30e7737caa37c9f2353d695429d70dc80be64fde) **vscode:** Change the rule entry that decides a model in Manage Model Approvals
- [`5879925`](https://github.com/oktawianwybieralski/coagent8/commit/58799254c4ac26fdac5c3e21226917e8a95b2de6) **vscode:** Uninstall removes only its own installation's profile entries
- [`2e9dab7`](https://github.com/oktawianwybieralski/coagent8/commit/2e9dab7cdd35c35ddb34cfb70b170af167cf47d2) **vscode:** Stop windows of one profile from rewriting the shared entry in turn
- [`1ff3f4e`](https://github.com/oktawianwybieralski/coagent8/commit/1ff3f4e5aa0403699a18b4de8a50a83851bc6487) **models:** Let a price limit choose any permitted effort variant
- [`6269fb4`](https://github.com/oktawianwybieralski/coagent8/commit/6269fb4f310732adac32000c7b3e30ff7e52249d) **vscode:** Synchronize and remove profile entries under one lease
- [`ff825e2`](https://github.com/oktawianwybieralski/coagent8/commit/ff825e249f8e23ec11c932870a90d95ed4b9456f) **vscode:** Keep the uninstall hook within its time limit while setup runs
- [`ee580cb`](https://github.com/oktawianwybieralski/coagent8/commit/ee580cbbfb7d6de1981b36575cd5eae82f4e8cdb) **vscode:** Check for outdated CLI chats in multi-root windows
- [`272193b`](https://github.com/oktawianwybieralski/coagent8/commit/272193b5e3cf5bdcaf30133815a20ed32fe10b1f) **vscode:** Open Manage Model Approvals in multi-root windows
- [`f89f5b1`](https://github.com/oktawianwybieralski/coagent8/commit/f89f5b1500c4cffa6382f4327e2312c22bc25a23) **vscode:** Finish CLI extension removals in multi-root windows
- [`9af3c9d`](https://github.com/oktawianwybieralski/coagent8/commit/9af3c9d26d241b2c509f736a27bea3323d7afd15) **vscode:** Record a first profile entry as pending before writing it
- [`19387b3`](https://github.com/oktawianwybieralski/coagent8/commit/19387b3b4ac315e2b743155ef3321738f4fef229) **vscode:** Keep cleaning other profiles when one cannot be read on uninstall
- [`9014aa1`](https://github.com/oktawianwybieralski/coagent8/commit/9014aa1187e99382e15aa74fbdf5006c43c64bec) **redaction:** Redact the canonical path of the home directory
- [`d8b4237`](https://github.com/oktawianwybieralski/coagent8/commit/d8b4237edd23a800854de39fa9279931a80016a1) **vscode:** Recognize the installation by its canonical path on uninstall
- [`d74c7c3`](https://github.com/oktawianwybieralski/coagent8/commit/d74c7c3bd0b7e58c20e25df51ab0389a2c6efd91) **review:** Name Git's reason when it refuses the repository
- [`5128c31`](https://github.com/oktawianwybieralski/coagent8/commit/5128c312eb33fd886e89b4562bef27dd913e188a) **vscode:** Open the extension page for Uninstall VS Code Extension
