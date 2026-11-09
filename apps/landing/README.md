# Landing site

Static Astro site for recount.cloud: the product pages, the changelog and legal pages, and the Starlight documentation under `/docs/`. Tailwind CSS uses the Tide Core tokens from `src/styles/global.css`. Cloudflare Workers serves the build output as static assets.

## Development

Run these commands from the repository root:

```sh
bun install --frozen-lockfile
just landing-dev
```

Astro prints the local URL (port 4321 by default). Forward Astro options after the recipe, for example `just landing-dev --port 5199 --host 0.0.0.0`.

```sh
bun run --cwd apps/landing check
bun run --cwd apps/landing build
bun run --cwd apps/landing preview
```

`check` runs `astro sync` and then `scripts/check.mjs`. The script runs the `astro check` diagnostics with this package's TypeScript 6, because the workspace root provides TypeScript 7, which does not yet expose the language-service API that `astro check` uses. `bun run typecheck` and `just check-web` include this check.

## Configuration

`PUBLIC_APP_URL` is read at build time, from the environment or `apps/landing/.env`.

| Variable         | Default | Meaning                                                                                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL` | Unset   | Web application URL for sign-in links and the signed-in check. While unset, those links go to the coming soon page (`/coming-soon/`). |

Cloudflare Web Analytics loads only on recount.cloud, using the public site token in `src/lib/analytics.mjs`, so previews and local builds are not counted.

With `PUBLIC_APP_URL` set, links into the web application read `GET /api/auth/get-session` with credentials to show "Open Recount" to signed-in visitors. The web application must allow this site's origin on that route; otherwise the signed-out labels remain.

## Content and languages

English pages live at `/` and French pages at `/fr/`. Every page needs both versions.

- `src/i18n/strings.ts`: landing page, pricing and contact copy for both languages.
- `src/pages/[...lang]/`: pages generated for each language.
- `src/content/changelog/{en,fr}/`: one Markdown file per changelog entry.
- `src/content/legal/{en,fr}/`: privacy policy and terms of service.
- `src/content/docs/docs/` and `src/content/docs/fr/docs/`: English and French documentation.

French text follows Québec usage. Use the web application's French catalog in `packages/i18n/messages/fr.json` for UI labels in the documentation.

Without a saved choice, visitors whose browser prefers French are redirected from English pages to French ones. The footer language switcher and the Starlight language picker save the choice in `localStorage` (`recount-locale`). The theme choice is shared with Starlight through `starlight-theme`.

## Deployment

`wrangler.jsonc` deploys the site as a Worker named `recount-landing` in the Cloudflare account set by `account_id`. Static files in `dist/` are served directly and unknown paths return `404.html`; only `/api/*` runs `worker/index.ts`. Production is served only at <https://recount.cloud>, a custom domain on the same account; the `workers.dev` address is disabled.

### Early access list

The coming soon page posts to `POST /api/notify`. The Worker checks the request origin and the email address, verifies the Cloudflare Turnstile token (site key in `src/lib/site.ts`, secret in the `TURNSTILE_SECRET` Worker secret), and stores the address and language in the `signups` table of the `recount-landing` D1 database. A repeated address succeeds without changing the list. Each new address also sends a short notice from `notify@recount.cloud` to the verified Email Routing address in the `NOTIFY_TO` Worker secret; without that secret, no notice is sent. On other hosts, such as pull request previews and `preview:worker`, the endpoint accepts valid addresses without verifying or storing them.

Schema changes are SQL files in `migrations/`. `deploy` and the workflow apply pending migrations before deploying; `bun run --cwd apps/landing db:migrate` applies them on their own. To read the list:

```sh
bunx wrangler d1 execute DB --remote --command "SELECT email, locale, created_at FROM signups ORDER BY created_at"
```

### Publishing

The [landing site workflow](../../.github/workflows/landing.yml) runs when a change touches `apps/landing/`, the root `package.json`, `bun.lock` or `.bun-version`:

| Event                             | Result                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `main` or manual run      | Checks and builds the site, then deploys it to production (`production` environment).                                                                                   |
| Pull request from this repository | Checks and builds the site, uploads a preview version without changing production, and comments its URL: `https://pr-<number>-recount-landing.<subdomain>.workers.dev`. |

The workflow needs a `CLOUDFLARE_API_TOKEN` repository secret with the **Workers Scripts: Edit** and **D1: Edit** permissions on the account, and passes the `PUBLIC_APP_URL` repository variable to the build. Pull requests from forks are skipped because they cannot read the secret.

To deploy from a workstation:

1. Sign in to Cloudflare with `bunx wrangler login`.
2. Set `PUBLIC_APP_URL` to the production web application URL.
3. Run `just landing-deploy`.

`bun run --cwd apps/landing preview:worker` builds the site and serves it with the Workers runtime locally.
