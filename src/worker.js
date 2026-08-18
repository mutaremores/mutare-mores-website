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
// with nonces -- without it the page wouldn't run at all. font-src needs
// data: because the display typefaces (TypewriterTest, FogleHunter, see
// public/shared-site-styles.css) are embedded as base64 data: URIs, not
// separate font files -- without it the browser silently fails to load
// them and falls back to Unbounded.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://app.cal.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
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

// The site is a single page that pans between "rooms" client-side, but each
// room and each Learn article also has a real URL so it can be shared,
// bookmarked, refreshed, and crawled (see ROOM_PATHS / routeFromLocation in
// public/index.html). None of these are real files, so a direct request for
// one would otherwise 404 -- these serve index.html instead and let the
// client route itself from location.pathname.
const SPA_ROOM_PATHS = new Set(["/about", "/work", "/assessment", "/learn"]);
const ARTICLE_PATH = /^\/learn\/([^/]+)\/?$/;

const SITE_ORIGIN = "https://mutaremores.com";
const DEFAULT_SOCIAL_IMAGE = `${SITE_ORIGIN}/social-share.png`;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strips tags and collapses whitespace from rendered article HTML, then
// truncates on a word boundary -- search results and social cards want a
// short plain-text blurb, not markup.
function excerptFromHtml(html, maxLen) {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

// Search engines and social-card scrapers mostly don't run the page's JS,
// so the per-article title/description have to already be in the HTML that
// comes back over the wire -- filling them in client-side after load would
// be invisible to them. This rewrites the <title> and the description/OG/
// Twitter meta tags for /learn/<slug> before the response goes out.
async function articleMetaHtml(html, slug, env, request) {
  const dataUrl = new URL("/articles.json", request.url);
  const res = await env.ASSETS.fetch(new Request(dataUrl, { headers: request.headers }));
  if (!res.ok) return html;
  const data = await res.json();
  const idx = (data.notionEntries || []).findIndex((e) => e.slug === slug);
  if (idx === -1) return html;

  const entry = data.notionEntries[idx];
  const nc = (data.noteContent || [])[idx] || {};
  const title = `${entry.t} — Mutare Mores`;
  const description =
    excerptFromHtml(nc.tldr || nc.notes, 200) ||
    "Notes on behavioral psychology, systems thinking, and creative leadership from Mutare Mores.";
  const url = `${SITE_ORIGIN}/learn/${slug}`;

  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${escapeHtml(description)}">`
    )
    .replace(
      /<meta property="og:type" content="[^"]*">/,
      `<meta property="og:type" content="article">`
    )
    .replace(
      /<meta property="og:title" content="[^"]*">/,
      `<meta property="og:title" content="${escapeHtml(title)}">`
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${escapeHtml(description)}">`
    )
    .replace(
      /<meta property="og:url" content="[^"]*">/,
      `<meta property="og:url" content="${escapeHtml(url)}">`
    )
    .replace(
      /<meta name="twitter:title" content="[^"]*">/,
      `<meta name="twitter:title" content="${escapeHtml(title)}">`
    )
    .replace(
      /<meta name="twitter:description" content="[^"]*">/,
      `<meta name="twitter:description" content="${escapeHtml(description)}">`
    )
    .replace(
      /<meta property="og:image" content="[^"]*">/,
      `<meta property="og:image" content="${DEFAULT_SOCIAL_IMAGE}">`
    );
}

function withSecurityHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const articleMatch = ARTICLE_PATH.exec(url.pathname);

    if (articleMatch || SPA_ROOM_PATHS.has(path)) {
      const indexUrl = new URL("/index.html", request.url);
      const indexRes = await env.ASSETS.fetch(new Request(indexUrl, { headers: request.headers }));
      let html = await indexRes.text();
      if (articleMatch) {
        html = await articleMetaHtml(html, decodeURIComponent(articleMatch[1]), env, request);
      }
      return withSecurityHeaders(
        new Response(html, { status: 200, headers: indexRes.headers }),
        { "Content-Type": "text/html; charset=utf-8" }
      );
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
