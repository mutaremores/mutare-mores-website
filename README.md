# Mutare Mores Website

Prototype website for the Mutare Mores coaching business.

## What's here

`public/index.html` is the entire site — HTML, CSS, and JS in one file (fonts and images embedded as base64 data URIs). It fetches `public/articles.json` at load time for all article/content data, so it always reflects whatever's currently in `content/articles/`.

## Editing content

Everything is written in **Notion** — Learn Articles (a database), the About page, and the Work With Me page. `scripts/notion-sync.mjs` pulls from Notion via its API and writes `content/articles/*.md` (one file per article) and `content/settings/{about,work}.json`, matching the shape `scripts/build-articles-json.mjs` already reads. A `content/settings/notion-sync-manifest.json` file maps Notion page ids to filenames so re-syncing updates the right file instead of creating duplicates.

The sync runs automatically once a day via `.github/workflows/notion-sync.yml` (a GitHub Actions cron), and can be run on demand from that workflow's page on GitHub ("Run workflow") — see `public/notion-sync.html` for a direct link. It needs a `NOTION_TOKEN` GitHub Actions repo secret (Settings → Secrets and variables → Actions); everything else uses the workflow's built-in `GITHUB_TOKEN`.

`content/settings/discovery-results.json` (the Discovery Assessment results page) and `content/settings/learn-welcome.json` are hand-edited directly in the repo — not synced from Notion.

At build time, `scripts/build-articles-json.mjs` reads all of `content/articles/*.md` and `content/settings/*.json` and writes the combined `public/articles.json` that `public/index.html` fetches — so a content edit only shows up on the live site after that build runs (Cloudflare Workers Builds runs it automatically on every push, see Deploying below — including the commits the Notion sync itself makes).

## Deploying

Deployed as a **Cloudflare Worker** (Workers Builds' Git integration), connected to this GitHub repo, auto-deploying on every push to `main`. `wrangler.jsonc` at the repo root defines the deploy: `src/worker.js` is the entry point, and it just serves everything in `public/` as static assets (via the `assets` binding) — there's no server-side logic left now that content comes from Notion instead of a CMS with its own login.

Project setup in the Cloudflare dashboard ("Set up your application" screen):

- **Build command**: `npm run build` (runs `scripts/build-articles-json.mjs`, which reads `content/articles/*.md` and writes `public/articles.json` — `wrangler deploy` then picks up everything in `public/` per `wrangler.jsonc`)
- **Deploy command**: default (`npx wrangler deploy`) — no changes needed, `wrangler.jsonc` already points it at `public/`
- **Path / API token**: leave at their defaults (repo root; Cloudflare auto-provisions the deploy token)

## Known placeholders

- (none currently)

## Roadmap ideas

- Split the single HTML file into separate CSS/JS files as the site grows, if maintainability becomes an issue.
- Add a favicon and richer social-sharing image once real brand assets exist (the homepage's "scribble ball" mark is a live randomized canvas animation, not a fixed image, so it isn't a direct source for one).
