# TapDash CRM

A merchant-services CRM: one master record store projected into five display
modules, with a granular Hidden / View / Edit permission system, a configurable
drawer, and a full audit trail.

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres, Auth,
Storage) · Vercel.

---

## What it does

**Six modules over one store.** Records List holds every record; Leads, Deals,
Contacts, Tickets and Residuals are projections of it. A record shown in several
modules is one row of data with independent presentation and pipeline position
in each.

**Everything is configuration, not code.** Modules, tabs, subtabs, fields,
choices and pipelines are rows in tables and are edited in Admin → Presets. No
business logic anywhere names a module.

**Permissions are the spine.** Every module, tab, subtab and field resolves to
Hidden, View or Edit per user, layered as a permission template plus per-user
overrides. A hidden field is absent from the query, never blanked in the
browser. Row visibility comes from the Team member field alone.

**Nothing is quietly lost.** Archive, Delete and Purge are three different
things. Deleted records, files, updates, case replies, login rows and users all
land in the Recycle Bin and can be restored. The activity log is append-only and
enforced as such in the database.

---

## Running it locally

```bash
npm install
cp .env.example .env      # then fill in the values, see below
npm run dev               # http://localhost:3000
```

### Environment

Every variable is documented in `.env.example`. The ones without which nothing
works:

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, server-only |
| `SUPABASE_DB_URL` | Project Settings → Database → Session pooler |
| `OTP_PEPPER` | `openssl rand -base64 32` |
| `LOGIN_ENC_KEY` | `openssl rand -base64 32` |
| `NEXT_PUBLIC_APP_URL` | the origin the app is served from |

`LOGIN_ENC_KEY` encrypts stored merchant credentials. Changing it makes every
already-stored password unreadable, so rotate it only with a re-encryption plan.

### The first user

Signup is invite-only and there is no open registration anywhere. Insert the
first invite directly, then complete signup in the browser:

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed/create-invite.sql
```

---

## Database

Every schema change is a numbered migration in `supabase/migrations/`. They are
applied by running their SQL directly, **and recorded** in
`supabase_migrations.schema_migrations` — both halves, or a later
`supabase db push` will try to re-run them:

```bash
node --env-file=.env scripts/apply-migration.mjs supabase/migrations/<file>.sql
```

The two counts must always match:

```bash
ls supabase/migrations/*.sql | wc -l
psql "$SUPABASE_DB_URL" -c 'select count(*) from supabase_migrations.schema_migrations'
```

Never change schema through the Supabase dashboard.

### Demo data

Fills every field on every record, plus notes, updates, cases, logins, files,
statements, messages and permission templates. Deterministic and safe to re-run;
it never deletes.

```bash
node --env-file=.env scripts/seed-demo-data.mjs
```

---

## Deploying to Vercel

1. Import the repository. The framework preset is Next.js and the defaults are
   correct; there is no `vercel.json` and none is needed.
2. Add every variable from `.env.example` under Project Settings → Environment
   Variables.
3. **Set `NEXT_PUBLIC_APP_URL` to the deployed origin.** Server Actions are
   accepted only from the host in that variable, so leaving it as
   `http://localhost:3000` makes every form in the app fail once deployed.
4. Deploy, sign in, then set `CSP_ENFORCE=true` and redeploy. The
   Content-Security-Policy ships report-only first so a missed directive breaks
   a report rather than the product.

Put the app in the same region as the Supabase project. The server makes a
number of round trips per page, so a mismatched region multiplies all of them.

---

## Checks

```bash
npm run verify      # typecheck + lint + tests
npm run build
```

`npm run verify` includes an integration suite that talks to the real Supabase
project, so it needs a working `.env`.
