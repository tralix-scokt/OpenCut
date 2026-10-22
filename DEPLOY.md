# Deploying OpenCut

OpenCut deploys to **Cloudflare Workers**. Two Workers come out of this repo:

| App         | Worker name  | What it is                                                        | Entry                          |
| ----------- | ------------ | ----------------------------------------------------------------- | ------------------------------ |
| `apps/web`  | `opencut-web`  | TanStack Start + React 19 frontend, SSR'd on Workers, static assets served from the same Worker | `@tanstack/react-start/server-entry` |
| `apps/api`  | `opencut-api`  | Elysia API (`/`, `/health`, `/echo`)                              | `src/index.ts`                 |

`apps/desktop` is a Rust/GPUI native app. It is **not** web-deployable — build it
locally per [apps/desktop/README.md](apps/desktop/README.md).

---

## Read this first: the `new.opencut.app` custom domain

`apps/web/wrangler.jsonc` commits a custom-domain route for **`new.opencut.app`**:

```jsonc
"routes": [{ "pattern": "new.opencut.app", "custom_domain": true }]
```

That domain belongs to the OpenCut project. **Unless the Cloudflare account you
deploy into has `opencut.app` in its zone, `wrangler deploy` fails** while trying
to attach it.

The deploy pipeline here handles that with
[`scripts/apply-deploy-config.mjs`](scripts/apply-deploy-config.mjs), which
rewrites the Worker name and routes at deploy time from environment variables:

| Variable        | Effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `WORKER_NAME`   | Worker name to deploy under.                                                |
| `WORKER_DOMAIN` | `none` → drop all routes and serve from your `*.workers.dev` subdomain. Any other value → attach it as a custom domain you control. Unset → leave the config untouched. |

The script is a **no-op unless one of those variables is set**, so it never
silently edits your config. The GitHub workflow defaults `WORKER_DOMAIN` to
`none` for the web Worker, which means a fork deploys successfully out of the
box to `https://<worker-name>.<your-subdomain>.workers.dev`.

To restore OpenCut's own production behaviour, set the `WEB_CUSTOM_DOMAIN`
repository variable to `new.opencut.app`.

---

## Prerequisites

1. A Cloudflare account.
2. **Account ID** — Cloudflare dashboard → Workers & Pages → overview page,
   shown in the right-hand sidebar. A 32-character hex string.
3. **API token** — Cloudflare dashboard → My Profile → API Tokens → *Create
   Token* → use the **Edit Cloudflare Workers** template. It needs:
   - Account → `Workers Scripts` → **Edit**
   - Account → `Workers KV Storage` → Edit (only if you later add KV bindings)
   - Zone → `Workers Routes` → **Edit** (only if you attach a custom domain)

---

## Option A — GitHub Actions (recommended)

The workflow is [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

### 1. Add the secrets

Repository → **Settings** → **Secrets and variables** → **Actions** → *Secrets*
tab → *New repository secret*:

| Name                    | Value                        |
| ----------------------- | ---------------------------- |
| `CLOUDFLARE_API_TOKEN`  | the API token from above     |
| `CLOUDFLARE_ACCOUNT_ID` | your 32-character account id |

### 2. (Optional) add variables

Same page → *Variables* tab → *New repository variable*:

| Name                  | Default when unset   | Purpose                                   |
| --------------------- | -------------------- | ----------------------------------------- |
| `WEB_CUSTOM_DOMAIN`   | `none` (workers.dev) | Custom domain for the web Worker          |
| `API_CUSTOM_DOMAIN`   | *(untouched)*        | Custom domain for the api Worker          |
| `WORKER_NAME_WEB`     | `opencut-web`        | Rename the web Worker                     |
| `WORKER_NAME_API`     | `opencut-api`        | Rename the api Worker                     |

Worker names are scoped per Cloudflare account, so the defaults are safe even on
a fork. Only rename them if you want a different URL.

### 3. Deploy

- **Manually:** repository → **Actions** → **Deploy** → *Run workflow*. Pick
  `all`, `web`, or `api`, and optionally override the web domain for that run.
- **Automatically:** pushing to `main` deploys, filtered to changes under
  `apps/web/**`, `apps/api/**`, `scripts/apply-deploy-config.mjs`, or the
  workflow file itself.

The job fails fast with an explicit error if either secret is missing, rather
than failing deep inside wrangler with an auth message.

---

## Option B — deploy from your machine

Wrangler authenticates interactively, so no token handling is needed:

```sh
proto use                 # installs the pinned bun 1.3.11 / moon / rust
bunx wrangler login       # opens a browser, authorises your account

# web (build, then deploy)
cd apps/web
bun install --frozen-lockfile
bun run build
bunx wrangler deploy

# api
cd ../api
bun install --frozen-lockfile
bunx wrangler deploy
```

Or from the repo root via moon:

```sh
moon run web:deploy
moon run api:deploy
```

**On a fork**, run the override script first so the `new.opencut.app` route is
dropped — it must run *before* `bun run build`, because
`@cloudflare/vite-plugin` reads `apps/web/wrangler.jsonc` at build time and bakes
the result into `dist/server/wrangler.json`:

```sh
WORKER_DOMAIN=none node scripts/apply-deploy-config.mjs apps/web/wrangler.jsonc
```

That rewrites the file in place (comments are lost, since the result is written
as JSON). Restore it afterwards with:

```sh
git checkout -- apps/web/wrangler.jsonc
```

---

## Verifying a deployment

```sh
# api
curl https://<api-worker>.<your-subdomain>.workers.dev/health
# -> {"healthy":true,"timestamp":"..."}

# web — should return SSR'd HTML
curl -i https://<web-worker>.<your-subdomain>.workers.dev/
```

---

## What was verified locally

The following was checked in a sandbox **without** Cloudflare credentials, so
nothing was uploaded to a real account:

- `bun install --frozen-lockfile` succeeds for both apps using bun **1.3.11**,
  the version pinned in `.prototools`.
- `apps/web` builds (`vite build`, client + SSR environments). Deploy dry-run
  resolves the Vite-generated `dist/server/wrangler.json`, attaches 8 modules and
  16 asset files: **945.16 KiB total upload / 208.63 KiB gzip**.
- `apps/api` builds (`wrangler deploy --dry-run`): **849.34 KiB / 156.33 KiB gzip**.
- Both Workers boot in `workerd` under `wrangler dev` and serve correctly:
  - api `/` → `{"status":"ok"}`, `/health` → healthy payload, `/echo` echoes the
    posted body.
  - web `/` and `/editor` return HTTP 200 SSR'd HTML; hashed CSS assets return 200.
- `apply-deploy-config.mjs` was exercised end to end: patching
  `apps/web/wrangler.jsonc` with `WORKER_NAME` / `WORKER_DOMAIN=none` flows
  through the Vite build into `dist/server/wrangler.json` with the renamed
  Worker, no routes, and `workers_dev: true`, and still passes `--dry-run`.

**Not** verified, because it needs a real Cloudflare account: the actual upload,
custom-domain attachment, and Workers Free-plan limits.

### Notes and caveats

- The web app is an early scaffold. `/` renders `hello world!` and `/editor`
  renders "Editor / Coming soon." — a successful deploy gives you a live URL, not
  a working editor.
- `bun.lock` files are committed so CI installs are reproducible. They must be
  generated with bun **1.3.11**: bun 1.4.x writes `lockfileVersion` 2, which
  1.3.11 rejects with `Unknown lockfile version`. Regenerate with the pinned
  version if you upgrade.
- `apps/web` and `apps/api` depend on several packages at `latest`
  (`@tanstack/react-start`, `@tanstack/react-router`, `elysia`,
  `wrangler`). The committed lockfiles pin what was tested; a `bun install`
  without `--frozen-lockfile` may resolve something newer.
- `bunfig.toml` sets `minimumReleaseAge = 604800` (7 days), so bun refuses
  packages published in the last week. A brand-new release of a `latest`
  dependency will not install until it is 7 days old.
- `wrangler deploy` for `apps/web` uses wrangler's Vite integration: it deploys
  the *built* output, so the build step is mandatory. Deploying without building
  first uploads stale assets.

---

## Troubleshooting

| Symptom                                                              | Cause / fix                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `Authentication error [code: 10000]`                                 | `CLOUDFLARE_API_TOKEN` missing, expired, or lacks *Workers Scripts: Edit*. Re-create from the template above.  |
| `Could not find zone for new.opencut.app` / custom-domain error       | You don't own that domain. Set `WEB_CUSTOM_DOMAIN=none` (or your own domain). See the first section.           |
| `A worker with this name is already in use` / account mismatch        | `CLOUDFLARE_ACCOUNT_ID` points at a different account than the token, or the name is taken. Set `WORKER_NAME_*`. |
| `Unknown lockfile version`                                           | Lockfile written by a newer bun. Regenerate with bun 1.3.11 (see notes).                                       |
| `lockfile had changes, but lockfile is frozen`                       | A dependency drifted. Run `bun install` locally with the pinned bun and commit the updated `bun.lock`.         |
| Web Worker serves stale assets                                       | The build step was skipped. `apps/web` must run `bun run build` before `wrangler deploy`.                      |
