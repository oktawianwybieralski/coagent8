# P0: Architecture boundaries and runtime reliability

CoAgent8 project rule. It adds requirements to the core rules in
[`core/`](core/) and never relaxes one. Violations block review and merge.

## Runtime reliability

- CoAgent8 runs bounded headless tasks and must cancel them reliably. Resource
  leaks (dangling processes, orphaned file descriptors, uncollected timers,
  unbounded buffers) are P0 defects. The full coagent direction extends these
  guarantees to delegated task trees; the
  [roadmap](../../docs/ROADMAP.md#full-coagent-direction) defines the stages.
- Tool arguments, CLI output and JSON payloads are validated with strict
  schemas (`validateToolArguments`, the MCP schema definitions). Third-party
  CLIs and callers are never assumed to behave well.
- Package metadata (`package.json`, `package-lock.json`, `plugin.json`,
  `server.json`, `extensions/vscode/package.json`), runtime constants
  (`BRAND.SERVER_VERSION`) and documentation reflect the actual state of the
  code. A development build never claims to be a release.

## Dependency and responsibility boundaries

These are invariants, not directory naming preferences. The
[architecture ownership map](../../docs/ARCHITECTURE.md#dependency-boundaries)
defines the dependency direction; the
[migration plan](../../docs/ROADMAP.md#simplify-001-module-boundary-migration)
records existing violations and their removal. A directory move alone does not
establish compliance. `npm run check:dependencies` verifies the graph.

- **One owner per capability.** A module owns one coherent capability and its
  side effects. Consumers call that owner; they do not copy its policy,
  persistence, validation or lifecycle logic.
- **Dependencies follow ownership.** Transport and UI layers call application
  operations. Application operations compose domain services and provider
  adapters. Domain policy and reusable mechanisms never import their callers,
  client transports, presentation code or installation/UI modules. Provider
  adapters translate provider protocols; they do not own routing or user
  approval policy. Review every cross-boundary dependency, types included.
- **No new cycles or hidden reverse dependencies.** No runtime or type-only
  import cycles. Dynamic imports, re-exports, barrel files, global registries
  and service locators cannot hide a forbidden dependency. Use a narrow
  contract owned by the consumer or a genuinely shared contract and supply its
  implementation at the composition boundary. Do not move all types into a
  common file merely to silence the dependency check.
- **Contracts are independent.** Shared request, result and event contracts do
  not load implementation modules or depend on MCP, editor or provider SDK
  types. Execution returns transport-independent results and evidence;
  transport formatting never owns or weakens policy, redaction or review
  acceptance.
- **Mechanisms do not acquire policy.** File locks, atomic writes, bounded I/O
  and process primitives implement their named effects only. They never load
  user configuration, choose models, start sessions or register clients as an
  incidental effect. Optional integration code stays outside the normal server
  startup dependency graph.
- **Existing violations are migration debt, not precedents.** Inventory exact
  edges and their removal stage before refactoring. Do not add edges to, expand
  or conceal a legacy cycle. Each migration slice removes its declared
  violations, preserves behavior, public contracts and stored data, and updates
  the ownership map. A new violation blocks acceptance.

Names follow the
[ownership boundaries](../../docs/ARCHITECTURE.md#names-define-responsibility);
TSDoc follows
[code documentation](../../docs/ARCHITECTURE.md#code-documentation-and-package-evidence).
