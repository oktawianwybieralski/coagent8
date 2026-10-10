# Changelog

All notable changes to CoAgent8 are documented in this file. It is generated
from the Conventional Commits history by [git-cliff](https://git-cliff.org/)
(`npm run changelog`); do not edit it by hand. Each entry starts with the commit
that introduced it.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Release procedure: [.agents/rules/02-git-workflow.md](.agents/rules/02-git-workflow.md).

## [Unreleased]

### Breaking
- [`ca8cf88`](https://github.com/oktawianwybieralski/coagent8/commit/ca8cf88ad560307cbb511a9e9f3b66a19da8c103) **execution:** Layered owned-process termination with protocol interrupts
- [`c0c030f`](https://github.com/oktawianwybieralski/coagent8/commit/c0c030fdf70d593e5c6fd555912ad3dc8d25561e) Require Node.js 24 and test on Node 24 and 26
- [`5ba52da`](https://github.com/oktawianwybieralski/coagent8/commit/5ba52da1caf4be61e9ed568f53b4f5b7ffc12f1e) **mcp:** Remove the compact tool profile
- [`e1f83e2`](https://github.com/oktawianwybieralski/coagent8/commit/e1f83e29fae3bc5be3b88190b8a5a4d315783aeb) **errors:** Typed ToolError codes; unknown failures are PROCESS_ERROR
- [`891875b`](https://github.com/oktawianwybieralski/coagent8/commit/891875b0fccec132efb5d9f42f4fa1dd175a9471) Stop tracking dist/ and check the packed bundle against a fresh build
- [`070ad58`](https://github.com/oktawianwybieralski/coagent8/commit/070ad58fd4ceca472eebc7211b84246176e32386) **sessions:** Scope MCP resources and session list to the workspace
- [`3480af4`](https://github.com/oktawianwybieralski/coagent8/commit/3480af430a606a8e704d8daf918283ee0f7fa78c) **policy:** Ask the user for top-tier models through MCP elicitation
- [`5a14941`](https://github.com/oktawianwybieralski/coagent8/commit/5a1494104a12df86b03180ef333edbb791498ae4) **result:** Return execution results as markdown only
- [`1d3c8dc`](https://github.com/oktawianwybieralski/coagent8/commit/1d3c8dc31e8b677c83db44df8480f747356a4414) **models:** Take models and defaults from the CLIs and config.json, never from the source
- [`ce882ba`](https://github.com/oktawianwybieralski/coagent8/commit/ce882baeb85c9c534325fee275b668a2eb55d328) **consent:** Ask the user by a model's approximate price, not by its name
- [`d937bc9`](https://github.com/oktawianwybieralski/coagent8/commit/d937bc934fa143d704a73f3d28de8e2bb6dfa5f6) **vscode:** One setup list, CLI executable choice and complete uninstall
- [`1353fb9`](https://github.com/oktawianwybieralski/coagent8/commit/1353fb94764dc1dd0324714a672dc60da4adedea) **vscode:** Share ~/.coagent8/config.json with the CLI and keep it on uninstall
- [`c144e4f`](https://github.com/oktawianwybieralski/coagent8/commit/c144e4f89e3062e3b31a05bf9774119fdf188db6) **doctor:** Default to a cached model view and move health to a scope

### Added
- [`2b17165`](https://github.com/oktawianwybieralski/coagent8/commit/2b171652b995f025c36a14ec710227cf64e3f733) **routing:** Choose another CLI than the client when auto is ambiguous
- [`81b5e2b`](https://github.com/oktawianwybieralski/coagent8/commit/81b5e2b417ae2b8b65e01c9071e3bb97796e2266) **doctor:** Summary by default, full detail, backend filter and quota switch
- [`16aca5c`](https://github.com/oktawianwybieralski/coagent8/commit/16aca5c5c6875efba64fd1a4305127007248e5d7) **mcp:** Resolve the workspace from client roots and report it
- [`49387f8`](https://github.com/oktawianwybieralski/coagent8/commit/49387f8c322b624da4d965fe009acc98d9468d0d) **tools:** Say how to call CoAgent8 right on the first attempt
- [`e414ea8`](https://github.com/oktawianwybieralski/coagent8/commit/e414ea81d00b04b90618e74b3e28ac8f4b304c08) **branding:** Support dark themes and record MCP observations
- [`b64413b`](https://github.com/oktawianwybieralski/coagent8/commit/b64413b772b4e1817dcd788c62f36ac04d5dd3cd) **setup:** Separate CLI readiness, host registration and cleanup
- [`6f81071`](https://github.com/oktawianwybieralski/coagent8/commit/6f81071ff97a7218249987868a2dc3c841e230c0) **execution:** Resolve agy from the Antigravity extension's copy
- [`35cf320`](https://github.com/oktawianwybieralski/coagent8/commit/35cf3205e75e4e953c79fbba62e4ec107c3cffb6) **vscode:** Offer vendor extensions and await CLIs during onboarding
- [`512eb48`](https://github.com/oktawianwybieralski/coagent8/commit/512eb4895841dc32f12b51b9f87a461f64e7a027) **vscode:** Open configuration and persist welcome dismissal
- [`4c6f08a`](https://github.com/oktawianwybieralski/coagent8/commit/4c6f08ab213a9e5655b3baea741f64ae92d4f620) **vscode:** Reset onboarding state through editor storage
- [`75c4aee`](https://github.com/oktawianwybieralski/coagent8/commit/75c4aee58f414f4930e5bd0522aa5d2ec6fe8e0f) **vscode:** Expose backend, model and approval settings
- [`fc61d08`](https://github.com/oktawianwybieralski/coagent8/commit/fc61d086ab10fdfc987575a84d298d4550088a1f) **vscode:** Remove extension registrations on uninstall
- [`31a1a1b`](https://github.com/oktawianwybieralski/coagent8/commit/31a1a1b7fa8bff8c55764c2834cd783a6a4fc94c) **selection:** List model prices in doctor and enforce output price limits
- [`bd4ebad`](https://github.com/oktawianwybieralski/coagent8/commit/bd4ebad158515a07f87a804a59df6fa930825819) **claude:** Read Claude Code's model catalog from stream-json initialize
- [`42968d1`](https://github.com/oktawianwybieralski/coagent8/commit/42968d13e0309224ea7758b9a6e127765fa1de98) **routing:** Route a named model to a backend that lists it
- [`d253e79`](https://github.com/oktawianwybieralski/coagent8/commit/d253e79f33563de9d4b8166d213e450bfaf839ca) **codex:** Read account rate limits from app-server
- [`bbe411a`](https://github.com/oktawianwybieralski/coagent8/commit/bbe411aff0e29cbbdc787261df2ef5c42ee74b36) **prices:** Keep per-model prices for offered models and refresh daily
- [`6896bdd`](https://github.com/oktawianwybieralski/coagent8/commit/6896bdd9497a098c83777084f7e91c93bcc17150) **mcp:** Frame every answer in a markdown code block
- [`e8c8177`](https://github.com/oktawianwybieralski/coagent8/commit/e8c817718a2be6ab6c4f18c9b4f4bc48681c1fd1) **mcp:** Present results raw for Codex and in plaintext frames elsewhere
- [`dc8353b`](https://github.com/oktawianwybieralski/coagent8/commit/dc8353bc9d9229a08b9eccc38354073dfdfdcf9d) **execution:** Implement phase timing and instrumentation (EXEC-001-T02)
- [`d6fb71e`](https://github.com/oktawianwybieralski/coagent8/commit/d6fb71ef2b7ba7a515865eacd483a4db97586223) **config:** Supply effective configuration with provenance (EXEC-001-T03)
- [`76b9560`](https://github.com/oktawianwybieralski/coagent8/commit/76b95608f5f84276ce3f9781faeb2a8fbd58a3a2) **execution:** Reuse observations within preparation (EXEC-001-T05)
- [`5f267fe`](https://github.com/oktawianwybieralski/coagent8/commit/5f267fecb47bc8d05bd4bd9b76738325885822cb) **execution:** Guarantee finalization after resource acquisition (EXEC-001-T06)
- [`82f002f`](https://github.com/oktawianwybieralski/coagent8/commit/82f002f773b5d4372760a05596e3cb7ae5c74ac7) **execution:** Define complete-call budget contract (EXEC-001-T07)
- [`e12ba41`](https://github.com/oktawianwybieralski/coagent8/commit/e12ba41d1215aad3b52f9a076ad26303530d1a64) **backends:** Define shared read and deadline context (EXEC-001-T08a)
- [`eda6a90`](https://github.com/oktawianwybieralski/coagent8/commit/eda6a90a81bd7183a50595070456c47ac8176161) **backends:** Implement shared-read waiter ownership (EXEC-001-T08b)
- [`92e1f87`](https://github.com/oktawianwybieralski/coagent8/commit/92e1f876d77801e448eae77fbea9924652f766b6) **codex:** Bound probe, catalog, and quota reads (EXEC-001-T08c)
- [`dfc69df`](https://github.com/oktawianwybieralski/coagent8/commit/dfc69dfff5d2852fb30a021c24d1343ae86bfe78) **claude:** Bound probe, catalog, and quota reads (EXEC-001-T08d)
- [`297716c`](https://github.com/oktawianwybieralski/coagent8/commit/297716c279178a16ee6637cba08cfc336ae2a200) **agy:** Bound probe, catalog, quota, and tool reads (EXEC-001-T08e)
- [`6823a87`](https://github.com/oktawianwybieralski/coagent8/commit/6823a874bb143f77ef9ae0eadfd27dee2f2004f3) **prices:** Bound price fetches and close shared-read races (EXEC-001-T08f)
- [`27f4881`](https://github.com/oktawianwybieralski/coagent8/commit/27f4881abccea58dd07f52c6c78b18509428a2cc) **review:** Bound review Git work and process lifecycle (EXEC-001-T09a)
- [`5ce4a5f`](https://github.com/oktawianwybieralski/coagent8/commit/5ce4a5f195407c3429de184f1c87133792821ed8) **storage:** Cancel lock waiters safely and preserve queue progress (EXEC-001-T09b)
- [`a5aea4b`](https://github.com/oktawianwybieralski/coagent8/commit/a5aea4bf9518285496da61b4f8de0cc957021505) **sessions:** Stop session acquisition after expiry (EXEC-001-T09c)
- [`f7c5599`](https://github.com/oktawianwybieralski/coagent8/commit/f7c55991ef6dbe9c1d44eb00c1fc1906bcea5039) **consent:** Cancel pending approval and bind to deadline (EXEC-001-T10a)
- [`06e1824`](https://github.com/oktawianwybieralski/coagent8/commit/06e1824172dddd5b1c32152904d0f3aaa1699e46) **consent:** Revalidate policy and price evidence before acquisition (EXEC-001-T10b)
- [`152b93d`](https://github.com/oktawianwybieralski/coagent8/commit/152b93d0aead7614026eefceb94e132dc184a452) **consent:** Preserve valid approvals across persistence failures (EXEC-001-T10c)
- [`2ba3bc9`](https://github.com/oktawianwybieralski/coagent8/commit/2ba3bc98abc6ae1bfa9d4d3dec2d4ee8e571e1f0) **execution:** Activate monotonic budget for consult and review (EXEC-001-T11a)
- [`1c5fe4f`](https://github.com/oktawianwybieralski/coagent8/commit/1c5fe4f0417747e2085e9b7e91ec374b6b39e12c) **setup:** Install client skills with each registration (SKILLS-001)
- [`64f7ee1`](https://github.com/oktawianwybieralski/coagent8/commit/64f7ee1e8952da6fa1389951313a56dbed705077) **diagnostics:** Apply bounds and cancellation to doctor (EXEC-001-T11b)
- [`98be250`](https://github.com/oktawianwybieralski/coagent8/commit/98be25003e270bee45a7699a8b92317e78670d1b) **execution:** Expose accurate timing and phase accounting (EXEC-001-T11c)
- [`195511e`](https://github.com/oktawianwybieralski/coagent8/commit/195511e10c2a7f5d5f53756123bb874732fed8a0) **review:** Say when another review cannot change the verdict (AX-007a)

### Changed
- [`6ccfd91`](https://github.com/oktawianwybieralski/coagent8/commit/6ccfd91df94882934d0048788fea97e7fcf58e5d) **src:** Group backend files per CLI and split shared modules
- [`4f0027c`](https://github.com/oktawianwybieralski/coagent8/commit/4f0027c6238ae87e435c999ec4db1c38999faeac) **src:** Place type definitions next to the modules that own them
- [`137a3f3`](https://github.com/oktawianwybieralski/coagent8/commit/137a3f3df7fbae9403872539db1f30b936e886b5) **src:** Import symbols from the modules that define them
- [`2ebb6ba`](https://github.com/oktawianwybieralski/coagent8/commit/2ebb6bae8674830e05eff98f75593dc04d68fc97) **src:** Delete dead code found by the audit
- [`7ad4eac`](https://github.com/oktawianwybieralski/coagent8/commit/7ad4eacc9034784a92c630dfad83e7dd370b160d) **src:** Drop StreamReducer line framing and test-only collector API
- [`b99782d`](https://github.com/oktawianwybieralski/coagent8/commit/b99782df904945062dd2760cfdb4a1f0afc8eb42) **src:** Stop exporting declarations used only in their own module
- [`5ab841f`](https://github.com/oktawianwybieralski/coagent8/commit/5ab841f212287daafe9406917c1cd61f41b760ee) **build:** Bundle the MCP server with tsdown and ship license notices separately
- [`918baea`](https://github.com/oktawianwybieralski/coagent8/commit/918baea495fc4cbc39ad6e28b8447e0f9927eb2e) **mcp:** One-sentence server instructions and compact tool definitions
- [`e40950b`](https://github.com/oktawianwybieralski/coagent8/commit/e40950bc904de79beba97fd737e1a8db909a6303) **result:** Compact structured content, one-line footer and actionable consent errors
- [`f4a075e`](https://github.com/oktawianwybieralski/coagent8/commit/f4a075e8d6d10fad77daa4e3b5bce657d400f030) **prompts:** Shorter review and consult prompts with a server-filled snapshot
- [`2dc46e4`](https://github.com/oktawianwybieralski/coagent8/commit/2dc46e48c3a961936b0ea49bc4f9ae1652db7360) **result:** Shorter footer with each line as its own quoted paragraph
- [`ec7844f`](https://github.com/oktawianwybieralski/coagent8/commit/ec7844fac5e8eac5f086bc80104e276deb8ebe17) **backends:** Reuse probes across requests and read agy quota only in doctor
- [`8d2c56b`](https://github.com/oktawianwybieralski/coagent8/commit/8d2c56b9ad530f703895c9c4351a27884f650ee8) **gemini:** Keep only the runCommand deadline
- [`68be8a2`](https://github.com/oktawianwybieralski/coagent8/commit/68be8a242c8289379a1fd550664be47c8134bbbf) **startup:** Inject background maintenance instead of environment test hooks
- [`c1ed6e7`](https://github.com/oktawianwybieralski/coagent8/commit/c1ed6e7f9cf7b37946448e90a01a779e0835fd62) **tools:** Map the deprecated tools and run actions through one alias table
- [`cb8c30b`](https://github.com/oktawianwybieralski/coagent8/commit/cb8c30bdab0021175b313bba8631f39df6f64489) **backends:** One structured-error extractor parameterized per backend
- [`651df5f`](https://github.com/oktawianwybieralski/coagent8/commit/651df5f9e6fdd965eb455b72b889f23d8a177eac) **progress:** Redact each progress message once, where it leaves for the client
- [`09e4943`](https://github.com/oktawianwybieralski/coagent8/commit/09e4943d7e8e3efb4e95aafb7b7ebf819ab4e7be) **probes:** Share concurrent probe, catalog and model reads
- [`b4f05f3`](https://github.com/oktawianwybieralski/coagent8/commit/b4f05f331bb57b023df728eba99e12d6a6728b88) **modules:** Extract contracts, storage, workspace and runtime
- [`7b65910`](https://github.com/oktawianwybieralski/coagent8/commit/7b65910acd71305ae52863801fca6548e0428239) **mcp:** Separate execution from MCP presentation (S2)
- [`a27209a`](https://github.com/oktawianwybieralski/coagent8/commit/a27209a40f77b914a919e1b4d077d14b8ec97520) **models:** Separate model policy from provider discovery (S3)
- [`0db784d`](https://github.com/oktawianwybieralski/coagent8/commit/0db784d707b3e8f1a58e1a3b29ebdd6c5c7b67ad) **sessions:** Split history by responsibility and extract credential boundaries (S4)
- [`4e4f471`](https://github.com/oktawianwybieralski/coagent8/commit/4e4f47115d0add848345bda62ed56399ee76e157) **layout:** Finish consumers, mirror test layout, and retire internal shims (S5)
- [`4933834`](https://github.com/oktawianwybieralski/coagent8/commit/4933834825348d1af81d443f453c4cab849a7ee7) **boundaries:** Enforce automated dependency boundaries and cycle detection (S6)
- [`8fb6325`](https://github.com/oktawianwybieralski/coagent8/commit/8fb6325a6e14983dcde6459f04886c98a8a4a2e1) **execution:** Establish reproducible baseline and call map (EXEC-001-T01)
- [`83214ff`](https://github.com/oktawianwybieralski/coagent8/commit/83214ff89aca16a5b0f2eff682514401fa46272f) **execution:** Extract cohesive task preparation (EXEC-001-T04)

### Fixed
- [`0c11032`](https://github.com/oktawianwybieralski/coagent8/commit/0c1103211b9efab5872b3b2ae6bd79ca02de7014) **execution:** Enforce process identity and safe teardown on Windows
- [`2b6a4d0`](https://github.com/oktawianwybieralski/coagent8/commit/2b6a4d0e978246cfbdc5d61c1fdacbbcca17637b) **execution:** Optimize process polling and align consumer package verification
- [`cd62aaf`](https://github.com/oktawianwybieralski/coagent8/commit/cd62aaf91a8ee7f60232738e99f35a99d3358886) **gemini:** Give agy a 2 s SIGTERM grace on POSIX
- [`8555d0c`](https://github.com/oktawianwybieralski/coagent8/commit/8555d0c3dd4014aa08534b47f35dd340d0591884) **redaction:** Split credential format from diagnostic redaction
- [`991b7e4`](https://github.com/oktawianwybieralski/coagent8/commit/991b7e4f20b5919cf8440d0532907d27089ff1fe) **build:** Order license notices independently of the build locale
- [`ba7edd9`](https://github.com/oktawianwybieralski/coagent8/commit/ba7edd9853fca71d4835ec4f0bb960dbc27e6b45) **history:** Append-only streaming deltas with credential tail buffering
- [`46984f0`](https://github.com/oktawianwybieralski/coagent8/commit/46984f0a3f106fb73ffba3b32dd6d9c201017eb6) **controller:** Isolate CLI execution from archive and session bookkeeping
- [`b205085`](https://github.com/oktawianwybieralski/coagent8/commit/b205085f967bee49ed90dc2e57698c8c61114e27) **history:** Address Opus review findings on tail buffering, capacity locking, and cooldowns
- [`bd1e63c`](https://github.com/oktawianwybieralski/coagent8/commit/bd1e63c0db81bf38984b7599807474fc795a9f8a) **history:** Address lock ordering, AWS key tail buffering, and capacity accounting
- [`5f4488b`](https://github.com/oktawianwybieralski/coagent8/commit/5f4488b28714780a303867f42123ad0e29b813f0) **history:** Restore JWT and Slack prefix checks and decouple append from capacity lock
- [`0cddde5`](https://github.com/oktawianwybieralski/coagent8/commit/0cddde59d02fc71912d9ce707a25c1a5b207e225) **history:** Safely catch rollback lock errors to guarantee original io error propagation
- [`46fa155`](https://github.com/oktawianwybieralski/coagent8/commit/46fa15551dbe961e9d93e8953523469101d58e4e) **backends:** Report the model each backend resolved
- [`c1cf900`](https://github.com/oktawianwybieralski/coagent8/commit/c1cf9007b1e46f6224d9c394f232b89e51455460) **gemini:** Keep the answer when the sandbox denies an action
- [`1f5ea07`](https://github.com/oktawianwybieralski/coagent8/commit/1f5ea07908d87f9501b3efa4549a9bf1c359e14b) **setup:** Raise the Codex tool timeout for CoAgent8 to 30 minutes
- [`abcff7d`](https://github.com/oktawianwybieralski/coagent8/commit/abcff7d142b2f4bee2d1e1678030e50c12a900fa) **routing:** Record one cooldown per rate-limited turn with the parsed reset
- [`bc04df9`](https://github.com/oktawianwybieralski/coagent8/commit/bc04df9159dd2dbcb19f6dad09e2fa1f7f19c45b) **codex:** Read the default model from config.toml with a TOML parser
- [`9cdb710`](https://github.com/oktawianwybieralski/coagent8/commit/9cdb710bb1a3b05229cb88089194077dca4a2935) **backends:** Reject option-like model identifiers before they reach a CLI
- [`d23ad1b`](https://github.com/oktawianwybieralski/coagent8/commit/d23ad1bb91a720d5ee1fce18d6d180315c2e1f6d) **gemini:** Ignore unknown agy event types with a warning
- [`35f015c`](https://github.com/oktawianwybieralski/coagent8/commit/35f015cb8bb65eec8c2ec8722296ac7798fdaa6e) **locks:** Publish leases atomically, renew them and reclaim stale ones by age
- [`cb0f723`](https://github.com/oktawianwybieralski/coagent8/commit/cb0f72326f71fbebe246876d0da680841249d485) **backends:** Classify CLI errors by anchored phrases and parse ms and decimal resets
- [`d88c07d`](https://github.com/oktawianwybieralski/coagent8/commit/d88c07dbe62c265c6ce1477617bcd7b33c159698) **gemini:** Treat a usage window without remaining_fraction as unmeasured
- [`96ebcfd`](https://github.com/oktawianwybieralski/coagent8/commit/96ebcfd99f0b687bacffa59722223d6d370e0ff4) **errors:** Remove dead catches and report the failures that were ignored
- [`8b43688`](https://github.com/oktawianwybieralski/coagent8/commit/8b436883d4655deadf25159acbb6008a849efe33) **config:** Report an unusable configuration in doctor and refuse execution
- [`07db345`](https://github.com/oktawianwybieralski/coagent8/commit/07db345b3b504c2936da0143bd53dc02834cb373) **history:** Replace empty catches with explicit absence and cache handling
- [`967a0e5`](https://github.com/oktawianwybieralski/coagent8/commit/967a0e53859fb25192432cd15f63b5f2a7bb63a2) **mcp:** Stop declaring resource list notifications that are never sent
- [`ee51b52`](https://github.com/oktawianwybieralski/coagent8/commit/ee51b5248ff10fcb14dd7ee32aec5589d489a8e1) **process:** Report POSIX group signal failures and skip the grace for an exited group
- [`cc95c1e`](https://github.com/oktawianwybieralski/coagent8/commit/cc95c1e9e9ced39d320e1e7b4f0e41f4f9834f2d) **result:** Keep answer lines that quote npm notices or update banners
- [`21e6bab`](https://github.com/oktawianwybieralski/coagent8/commit/21e6bab365f0e7255cc34fcf42d5980417e6deae) **session:** Report cancelled only when a running turn was stopped or released
- [`26ac5fd`](https://github.com/oktawianwybieralski/coagent8/commit/26ac5fd9fadd79f880bbf7215b9bb2e607637a07) **session:** Show workspace paths under the home directory as ~ in session lists
- [`e5a89f0`](https://github.com/oktawianwybieralski/coagent8/commit/e5a89f00a95d09633d965e9efdc4ace456574ca9) **errors:** Type rejected models and drop the invented answer of a failed run
- [`8d12ee6`](https://github.com/oktawianwybieralski/coagent8/commit/8d12ee6ec2f1262519469952ac1049f8cefbf6bb) **models:** Check model and effort against the catalog the CLI reports
- [`50f2146`](https://github.com/oktawianwybieralski/coagent8/commit/50f214636295065102c886b982335163f779c1c7) **codex:** Return the final answer without the turn's commentary
- [`bf73c79`](https://github.com/oktawianwybieralski/coagent8/commit/bf73c79aa0b7ed0566e4dbaef37c2e45d11069fb) **consult:** Pass a plain question on as asked
- [`2437d98`](https://github.com/oktawianwybieralski/coagent8/commit/2437d98886a4e7e7d08dba163ff867153cda4823) **result:** Name the requested model in the footer of a refused call
- [`d811099`](https://github.com/oktawianwybieralski/coagent8/commit/d811099477da70e79f431238a46b6740a4c65e85) **consent:** Accept only an explicit approve: true as the user's consent
- [`690b3d0`](https://github.com/oktawianwybieralski/coagent8/commit/690b3d022364eba3c063bd91db89f5d5803bf06f) **session:** Keep the session's reasoning effort on a continuation
- [`dcf9a90`](https://github.com/oktawianwybieralski/coagent8/commit/dcf9a90f3605419f0465cc7e9005c30dee4b481b) **gemini:** Disable agy's auto-updater, whose console window takes the focus
- [`0c89f70`](https://github.com/oktawianwybieralski/coagent8/commit/0c89f7063f8351012be36e821eb158ecfed62b6c) **consent:** Report a cancelled approval request as unanswered, not declined
- [`84bd6cf`](https://github.com/oktawianwybieralski/coagent8/commit/84bd6cf9ca13de348ae9536ac01ef4c86f7e8afc) **vscode:** Clarify CLI names and embed private preview logo
- [`7028da8`](https://github.com/oktawianwybieralski/coagent8/commit/7028da85fe3a05d1473fe9518e8bef153963458c) **vscode:** Use the new okidev publisher
- [`505cc77`](https://github.com/oktawianwybieralski/coagent8/commit/505cc7724ef4a37d1d755834c0866829bc8bd9c2) **vscode:** Replace broken Details logo with compact links
- [`075e264`](https://github.com/oktawianwybieralski/coagent8/commit/075e264efb6567e36135c92641dee65f3334558e) **vscode:** Discover bundled Codex and offer CLI installation
- [`a500347`](https://github.com/oktawianwybieralski/coagent8/commit/a500347b010173c838973430abb9fd0dd8acbfd0) **setup:** Preserve CLI evidence and verify owned cleanup
- [`1fe2386`](https://github.com/oktawianwybieralski/coagent8/commit/1fe2386fd4fdbb6eaccdd712a252f6eb2671a383) **setup:** Read CLI help from stderr as well as stdout
- [`2b32af7`](https://github.com/oktawianwybieralski/coagent8/commit/2b32af7702dd60d516b864adb463d2df2201c685) **vscode:** Keep the CLI picker open while setup checks run
- [`5dc8b03`](https://github.com/oktawianwybieralski/coagent8/commit/5dc8b039b21612fa140402b1339a89752e98237d) **setup:** Detect Antigravity CLI sign-in with its silent check
- [`7402f5e`](https://github.com/oktawianwybieralski/coagent8/commit/7402f5ea2bdc5d5e4a990e69e4e73633ef387bb2) **setup:** Report unregistered CLIs clearly and log one line per check
- [`f8d2cb4`](https://github.com/oktawianwybieralski/coagent8/commit/f8d2cb4b22bf651ad0ec503cb692f6c96d68015d) **adapters:** Disable and verify inherited Codex MCP servers per thread
- [`2b7e612`](https://github.com/oktawianwybieralski/coagent8/commit/2b7e612ede0374c4954c59bb55b283043e8e310b) **adapters:** Refuse recursive turns and name agy's inherited tools
- [`3c98992`](https://github.com/oktawianwybieralski/coagent8/commit/3c989927695f6f6d5496a7ce773d3becca5bb489) **review:** Bind verdicts to complete current workspace input
- [`07ba077`](https://github.com/oktawianwybieralski/coagent8/commit/07ba07709dd6d7d804dc0a0fd2ddac330d67ad55) **vscode:** Bind configuration and refresh MCP definitions
- [`143536e`](https://github.com/oktawianwybieralski/coagent8/commit/143536e79d61850e55a6407be71c83e97dd567ab) **vscode:** Keep extension data in storage removed on uninstall
- [`c2e3da9`](https://github.com/oktawianwybieralski/coagent8/commit/c2e3da9180316de5bef08ddd37b905868be3dbf7) **routing:** Keep auto selection working without a writable quota cache
- [`056d1c4`](https://github.com/oktawianwybieralski/coagent8/commit/056d1c4f1f32f25a06a5ef810c10aaa576f789b5) **codex:** Keep a complete final answer untruncated after dropped commentary
- [`fdbdf99`](https://github.com/oktawianwybieralski/coagent8/commit/fdbdf9977c72f615d03171bc5d377d958a5ad5f5) **history:** Reserve snapshot bytes before writing them
- [`2e24b66`](https://github.com/oktawianwybieralski/coagent8/commit/2e24b66a902501e1dee47bad409904d9cbd77954) **history:** Cut fragments at UTF-8 character boundaries
- [`e198a8b`](https://github.com/oktawianwybieralski/coagent8/commit/e198a8b73498085f1e3c1bcf8fed9a65898e6834) **prices:** Let shutdown wait for a background price read
- [`3c36bf0`](https://github.com/oktawianwybieralski/coagent8/commit/3c36bf08eb5986142a9c8e1d8ff51121241375db) **backends:** Stop reporting a complete answer as truncated
- [`7bd8ca0`](https://github.com/oktawianwybieralski/coagent8/commit/7bd8ca0a19a25b575870a0d9874acb932a36d9a2) **review:** Show the reviewer answer verbatim and report every block cause
- [`ed4a1db`](https://github.com/oktawianwybieralski/coagent8/commit/ed4a1dbfba3077bed76c28f2e4d8939dc5f56a0c) **agy:** Report a turn ended by a sandbox denial as a failure
- [`0a932ac`](https://github.com/oktawianwybieralski/coagent8/commit/0a932acec72d8959b9e7a6600af251ff05752499) **setup:** Update owned Claude and agy registrations to the new runtime
- [`af9f7d2`](https://github.com/oktawianwybieralski/coagent8/commit/af9f7d2f1b6869f053e6b20b8d6ff59d811edf7d) **boundaries:** Reject SDK and indirect transport dependencies
- [`a90cd40`](https://github.com/oktawianwybieralski/coagent8/commit/a90cd40ca21d499688e28a2754ce8b5126d6c7c8) **tests:** Bound concurrency barrier and ensure guaranteed task settlement
- [`ad25d4e`](https://github.com/oktawianwybieralski/coagent8/commit/ad25d4e2810dedc7891a9d57ebbc9b9770318579) **tests:** Bound child readiness and teardown in lock contention test (EXEC-001-T09b)
- [`6d35ff0`](https://github.com/oktawianwybieralski/coagent8/commit/6d35ff085ea4a3b1ce22dd6e5c1136efbd569292) **diagnostics:** Preserve prefilled issue links in chat clients
- [`19a9953`](https://github.com/oktawianwybieralski/coagent8/commit/19a9953dcaf3c340832c931855e5b734cd70164c) **quota:** Keep other providers when the cache cannot be read (AUDIT-001-A01-A03)
- [`4936ae7`](https://github.com/oktawianwybieralski/coagent8/commit/4936ae711c8477ab6205fcf7a352bada5824f878) **config:** Serialize saveConfig under the configuration lease (AUDIT-001-A04-A05)
- [`57ca63d`](https://github.com/oktawianwybieralski/coagent8/commit/57ca63d01f50ee3b0a5cbda930b47a1abe860f9f) **config:** Write configuration through the shared atomic writer (AUDIT-001-A06-A07)

## [1.0.0-beta.1] - 2026-10-05 ([`v1.0.0-beta.1`](https://github.com/oktawianwybieralski/coagent8/tree/v1.0.0-beta.1))

### Added
- Canonical tool surface: `consult` (with `task_type`), `review`, `doctor`,
  `session`, `cancel`, `issue`; compact profile through `run`.
- Plain `consult` answers with a structured `verdict` field; the State Envelope is
  enforced for `review` only.
- Generic MCP interoperability: tools are listed without a recognized client and
  without invoking a backend.
- Optional `setup`, `repair` and `status` commands for Codex, Claude Code and agy
  host registration, reused by the VS Code extension.
- Claude Code backend in restricted read-only mode with streaming and resume.
- Claude Code subscription quota read from `/usage` before routing.
- Native Gemini (`agy`) quota inspection in `doctor`.
- Focused test file selection in `tests/run.cjs`.

### Changed
- Session pruning runs in the background after the MCP transport connects.
- Backend resolution no longer writes the default backend to the configuration.
- Hidden PowerShell windows for Windows process supervision and tests.
- License changed to GPL-3.0-only.
- Product and npm package renamed to CoAgent8 (`coagent8`).

### Deprecated
- Tools `analyze`, `debug` and `implement`; use `consult` with `task_type`.
  Removal is planned for v1.1.0.

### Fixed
- Gemini sandbox-denial handling no longer reports valid results as duplicates.
- Escaped and structured Windows home paths are redacted in diagnostics.
- Claude Code events require `init`, `inspectQuota` is version-gated and
  sessions are hardened.
- Adapter startup errors keep their diagnostics; billing failures map to
  authentication errors.
