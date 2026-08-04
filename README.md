# Mutare Mores Website

Prototype website for the Mutare Mores coaching business.

## What's here

`public/index.html` is the entire site — HTML, CSS, and JS in one file (fonts and images embedded as base64 data URIs). It fetches `public/articles.json` at load time for all article/content data, so it always reflects whatever's currently in `content/articles/`.

## Editing content

Article copy lives in `content/articles/*.md` (one file per article, edited through the Decap CMS at `/admin`, which authenticates via GitHub). Site-wide text (About page, Work with Me page, Learn intro) lives in `content/settings/*.json`, also editable through `/admin`.

`/admin` (`public/admin/index.html`) is a **Browse & Edit** landing page, not the Decap app itself: a clickable list of every article — title, status, category, topics — styled like the real Learn page. Clicking any row opens that article directly in the Decap editor (`/admin/editor.html#/collections/article/entries/<slug>`), instead of hunting for it in Decap's own list view. It reads `public/articles.json` at load time, same as the live site. The actual Decap CMS app lives at `/admin/editor.html` (linked from a bar at the top of the browse page, and from a bar at the top of every Decap screen back to the browse page).

At build time, `scripts/build-articles-json.mjs` reads all of `content/articles/*.md` and `content/settings/*.json` and writes the combined `public/articles.json` that `public/index.html` fetches — so a content edit only shows up on the live site after that build runs (Cloudflare Workers Builds runs it automatically on every push, see Deploying below).

## Deploying

Deployed as a **Cloudflare Worker** (Workers Builds' Git integration), connected to this GitHub repo, auto-deploying on every push to `main`. `wrangler.jsonc` at the repo root defines the deploy: `src/worker.js` is the entry point, and it serves everything in `public/` as static assets (via the `assets` binding) except for two routes it handles itself, `/auth` and `/callback` (the Decap CMS GitHub login flow — see `src/worker.js` for details).

Project setup in the Cloudflare dashboard ("Set up your application" screen):

- **Build command**: `npm run build` (runs `scripts/build-articles-json.mjs`, which reads `content/articles/*.md` and writes `public/articles.json` — `wrangler deploy` then picks up everything in `public/` per `wrangler.jsonc`)
- **Deploy command**: default (`npx wrangler deploy`) — no changes needed, `wrangler.jsonc` already points it at `public/`
- **Path / API token**: leave at their defaults (repo root; Cloudflare auto-provisions the deploy token)
- **Environment variables set on this screen are build-time only** — they will *not* be visible to `src/worker.js` at runtime. `GITHUB_OAUTH_ID` and `GITHUB_OAUTH_SECRET` additionally need to be added under the deployed Worker's own **Settings → Variables and Secrets** (`GITHUB_OAUTH_SECRET` as an encrypted Secret), or `/auth` and `/callback` will 500. These must also match the callback URL registered on the corresponding GitHub OAuth App (`https://<your-domain>/callback`).

## Known placeholders

- Article content in the Learn section is a static snapshot, not connected to a live source like Notion.

## Roadmap ideas

- Split the single HTML file into separate CSS/JS files as the site grows, if maintainability becomes an issue.
- Add a favicon and richer social-sharing image once real brand assets exist (the homepage's "scribble ball" mark is a live randomized canvas animation, not a fixed image, so it isn't a direct source for one).
