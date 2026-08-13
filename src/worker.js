// Worker entry point for mutaremores.com (see wrangler.jsonc). Content
// comes from Notion now (see scripts/notion-sync.mjs, run by
// .github/workflows/notion-sync.yml), so this just serves the static
// site files in public/ via the ASSETS binding -- Decap CMS and its
// GitHub OAuth login (/auth, /callback) were removed along with it.
//
// Security headers are added on top of Cloudflare's own defaults --
// the ASSETS binding doesn't set any of these itself. The CSP's
// allow-list matches exactly what public/index.html actually loads:
// three.js and the Cal.com booking widget script, Google Fonts, and
// the site's own same-origin fetch('articles.json'). script-src and
// style-src need 'unsafe-inline' because the whole site is one inline
// <script>/<style> (see public/index.html) rather than external files
// with nonces -- without it the page wouldn't run at all.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://app.cal.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src https://cal.com https://app.cal.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
