// Worker entry point for mutaremores.com (see wrangler.jsonc). Content
// comes from Notion now (see scripts/notion-sync.mjs, run by
// .github/workflows/notion-sync.yml), so this just serves the static
// site files in public/ via the ASSETS binding -- Decap CMS and its
// GitHub OAuth login (/auth, /callback) were removed along with it.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
