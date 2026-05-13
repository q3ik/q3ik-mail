# Migration Notes for Duplicate `003_` Prefix Rename

This PR renumbers migration filenames to remove a duplicate `003_` prefix:

- `003_add_r2_body_keys.sql` → `004_add_r2_body_keys.sql`
- `004_add_attachments.sql` → `005_add_attachments.sql`

## Environment verification before merge

Before merging, run this command for each persistent environment and record the output in the PR thread:

```bash
cd apps/worker
npx wrangler d1 migrations list q3ik-mail-db --remote
```

Track results:

- Production: _pending manual verification by maintainer_
- Staging: _pending manual verification by maintainer_
- CI: uses ephemeral local D1 state on each run (no persistent remote ledger)

## Apply runbook

1. Verify migration ledger state first using `wrangler d1 migrations list`.
2. If an environment has already applied old names (`003_add_r2_body_keys.sql` and `004_add_attachments.sql`), stop and do not apply renamed files to that environment.
3. If an environment has **not** applied those old names, apply normally:

```bash
cd apps/worker
npx wrangler d1 migrations apply q3ik-mail-db --remote
```

## Rollback / recovery guidance

If migration state is inconsistent in any environment:

1. Do not continue applying migrations.
2. Export current schema and migration ledger for incident review:

```bash
cd apps/worker
npx wrangler d1 execute q3ik-mail-db --remote --command "SELECT * FROM d1_migrations ORDER BY id;"
```

3. Resolve by follow-up migration(s) rather than editing already-applied files.
