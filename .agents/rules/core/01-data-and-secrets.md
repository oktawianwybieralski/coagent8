# P0: Data and secrets

## Business data

- Business data (customers, prices, orders, accounts and the like) changes only
  through the application's supported services and workflows, never through
  direct writes to tables a framework owns. `.agents/project.md` or the
  project rules name those services.
- Imports and bulk operations are idempotent (stable external IDs, upsert, no
  duplicates on rerun), support a dry run that reports the planned changes,
  and never overwrite data edited in the application unless the import
  contract says so.
- Demo seed data runs only locally and in tests. It stays separate from
  business configuration and from production imports.

## Migrations

- Never edit or delete a migration that has been applied anywhere outside your
  machine. Fix forward with a new migration.
- Review the SQL of every generated migration.
- Destructive changes (drop, rename, type change) go in stages so that the
  previous and the new code both run on the schema during a deploy.
- Before any production migration: a verified backup and a written restore
  path.

## Integrations

- External calls are idempotent, retried with limits, deduplicated and logged
  for audit. A step whose effect cannot be undone (a sent parcel, an issued
  invoice, a published package) is modeled as forward-only with
  reconciliation, not as something a compensation can roll back.

## Secrets and personal data

- Secrets and environment-specific addresses live only in gitignored env files
  or a secret store. No hard-coded hosts, IPs, keys or passwords in code or
  configuration.
- An env template lists every variable the code reads, with safe example
  values, never real ones. Required variables are validated at startup.
- No personal data in the repository, fixtures, screenshots, prompts to
  external agents, issues or CI logs. Use synthetic data.
- Agents never read, print, copy or commit secret values, env files or private
  keys.
- Production backups are automatic, stored off the server, kept for a defined
  retention and restored in a regular test.
