// Reads every article file in content/articles/*.md and rebuilds the three
// parallel arrays (notionEntries, noteContent, articleLinks) the site's
// existing JS expects, writing them to public/articles.json.
//
// Order: articles with a legacy `origIndex` (from the original migration)
// keep that relative order first, so all existing cross-references (the
// hard-coded related-article index numbers used by the discovery-assessment
// result page) keep pointing at the right article. New articles created in
// Tina after the migration are appended at the end in filename order.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";

const CONTENT_DIR = path.resolve("content/articles");
const OUT_FILE = path.resolve("public/articles.json");

// Two renderers, deliberately different: settings content (about.json,
// work.json, discovery-results.json) is hand-edited directly in this repo,
// so only trusted committers can put raw HTML in it -- work.json actually
// relies on that today (a hand-crafted <a id="..."> for a JS click hook).
// Article content comes from Notion instead, which isn't the same trust
// boundary (anyone with edit access to that Notion database, now or in the
// future, could put a live <script> in a page and have it render unescaped
// on every visitor's browser) -- so html stays off there.
const mdRenderer = new MarkdownIt({ html: true, linkify: true });
const mdRendererArticles = new MarkdownIt({ html: false, linkify: true });

function htmlFromMarkdown(str) {
  if (!str) return "";
  return mdRenderer.render(str).trim();
}

function htmlFromArticleMarkdown(str) {
  if (!str) return "";
  return mdRendererArticles.render(str).trim();
}

const files = fs
  .readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

const parsed = files.map((file) => {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf-8");
  const { data, content } = matter(raw);
  return { file, data, body: content };
});

// Legacy-indexed articles first (stable original order), then new ones.
const withLegacy = parsed.filter((p) => Number.isInteger(p.data.origIndex));
const withoutLegacy = parsed.filter((p) => !Number.isInteger(p.data.origIndex));
withLegacy.sort((a, b) => a.data.origIndex - b.data.origIndex);
withoutLegacy.sort((a, b) => a.file.localeCompare(b.file));

const ordered = [...withLegacy, ...withoutLegacy];

const notionEntries = [];
const noteContent = [];
const articleLinks = [];

for (const p of ordered) {
  const d = p.data;
  notionEntries.push({
    t: d.title || "Untitled",
    cat: d.category || null,
    topics: d.topics || [],
    src: d.sources || [],
    prog: d.status || "Not started",
    first: d.firstPublished
      ? String(d.firstPublished).slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    // Stable id (survives other articles being added/deleted, unlike this
    // entry's array position) for the few places in the site's JS that need
    // to point at one specific article — e.g. the radar chart's per-dimension
    // "read more" links. Only legacy-migrated articles have one.
    oi: Number.isInteger(d.origIndex) ? d.origIndex : null,
    // Filename (minus .md) doubles as this article's slug -- unlike oi
    // above, every article has one, so it's what in-article cross-links
    // (article:<slug> hrefs, inserted via the CMS's "Link to Article" tool)
    // resolve against. See public/index.html's slugToPos.
    slug: p.file.replace(/\.md$/, ""),
  });

  const notesHtml = htmlFromArticleMarkdown(p.body);
  noteContent.push({
    tldr: htmlFromArticleMarkdown(d.tldr || ""),
    notes: notesHtml,
    resources: htmlFromArticleMarkdown(d.resources || ""),
    // "Has this been written up?" is derived from the body field itself
    // now, not a separate manual checkbox — if there's real body content,
    // it's written up.
    has: !!(p.body && p.body.trim()),
  });

  articleLinks.push({
    last: d.lastEdited || "",
  });
}

// "Linked Articles" backlinks: for every in-body article: link (inserted
// via the CMS's "Link to Article" tool, in tldr/notes/resources), record
// the source article against the link's target so each article can show
// what else links to it. Recomputed from scratch on every build rather
// than stored per-article, so it stays correct automatically as Notion
// sync adds, edits, or removes cross-links -- including a link added later
// from an article that predates its target.
const slugToIdx = new Map(notionEntries.map((e, i) => [e.slug, i]));
const linkedFromMap = new Map(); // target slug -> [] of source idx, in appearance order
noteContent.forEach((nc, i) => {
  const combinedHtml = `${nc.tldr}${nc.notes}${nc.resources}`;
  const seenTargets = new Set();
  for (const m of combinedHtml.matchAll(/href="article:([^"#?]+)"/g)) {
    const targetSlug = m[1];
    if (targetSlug === notionEntries[i].slug) continue; // no self-links
    if (!slugToIdx.has(targetSlug)) continue; // dead/unresolved link target
    if (seenTargets.has(targetSlug)) continue; // one entry per source article
    seenTargets.add(targetSlug);
    if (!linkedFromMap.has(targetSlug)) linkedFromMap.set(targetSlug, []);
    linkedFromMap.get(targetSlug).push(i);
  }
});
notionEntries.forEach((e, i) => {
  noteContent[i].linkedFrom = (linkedFromMap.get(e.slug) || []).map((srcIdx) => ({
    slug: notionEntries[srcIdx].slug,
    t: notionEntries[srcIdx].t,
  }));
});

// Site-wide content that isn't a Learn article (currently just the Learn
// "Start Here" welcome column heading/intro), edited via the CMS's Site
// Settings entry and written to content/settings/learn-welcome.json.
let learnWelcome = {
  heading: "Start Here",
  intro:
    "This library grows out of real coaching notes and reading. Pick a way in, or browse everything.",
};
const welcomePath = path.resolve("content/settings/learn-welcome.json");
if (fs.existsSync(welcomePath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(welcomePath, "utf-8"));
    learnWelcome = { ...learnWelcome, ...parsed };
  } catch (e) {
    console.warn(`Could not parse ${welcomePath}, using defaults:`, e.message);
  }
}

// About page: a flat list of {heading, body} sections, edited via the CMS's
// "About page" Site Settings entry and written to content/settings/about.json.
let about = { sections: [] };
const aboutPath = path.resolve("content/settings/about.json");
if (fs.existsSync(aboutPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(aboutPath, "utf-8"));
    about = {
      sections: (parsed.sections || []).map((s) => ({
        heading: s.heading || "",
        bodyHtml: htmlFromMarkdown(s.body || ""),
      })),
    };
  } catch (e) {
    console.warn(`Could not parse ${aboutPath}, using defaults:`, e.message);
  }
}

// Work with Me page: mostly-fixed structure (What I Do / Discovery Call /
// two-column accordion / closing FAQ accordion), edited via the CMS's
// "Work with me page" Site Settings entry, written to content/settings/work.json.
let work = {
  whatIDoHtml: "",
  discoveryCallHtml: "",
  columns: [],
  workOnOutroHtml: "",
  faq: [],
};
const workPath = path.resolve("content/settings/work.json");
if (fs.existsSync(workPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workPath, "utf-8"));
    work = {
      whatIDoHtml: htmlFromMarkdown(parsed.whatIDo || ""),
      discoveryCallHtml: htmlFromMarkdown(parsed.discoveryCall || ""),
      columns: (parsed.columns || []).map((c) => ({
        title: c.title || "",
        items: (c.items || []).map((it) => ({
          summary: it.summary || "",
          bodyHtml: htmlFromMarkdown(it.body || ""),
        })),
      })),
      workOnOutroHtml: htmlFromMarkdown(parsed.workOnOutro || ""),
      faq: (parsed.faq || []).map((it) => ({
        summary: it.summary || "",
        bodyHtml: htmlFromMarkdown(it.body || ""),
      })),
    };
  } catch (e) {
    console.warn(`Could not parse ${workPath}, using defaults:`, e.message);
  }
}

// Discovery Assessment Results page: one What it means / Strengths /
// Considerations bullet set per dimension per High/Low reading, edited via
// the CMS's "Discovery Assessment Results page" Site Settings entry and
// written to content/settings/discovery-results.json. Shown as one page by
// public/index.html's insertResultsColumn, instead of linking out to
// separate per-dimension articles the way it used to.
//
// Stored flat (36 top-level keys like "creativityHighStrengths") rather
// than nested -- Decap's nested object-widget version crashed the whole
// Site Settings collection's data loading (see the comment in
// public/admin/config.yml next to this entry). Each field is one plain
// text widget (one bullet per line) rather than a list widget -- list
// versions never populated existing data even when otherwise correctly
// configured, for reasons not fully pinned down; text is the pattern
// already proven reliable elsewhere in this file. Split on newlines and
// reassembled into the nested { dim: { high/low: { category: [...] } } }
// shape here, once, so public/index.html's insertResultsColumn doesn't
// need to know about the storage-format workaround.
const DISCOVERY_DIMENSIONS = ["creativity", "eq", "vision", "influence", "execution", "adaptability"];
const DISCOVERY_CATEGORIES = ["whatItMeans", "strengths", "considerations"];
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
let discoveryResults = {};
const discoveryResultsPath = path.resolve("content/settings/discovery-results.json");
if (fs.existsSync(discoveryResultsPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(discoveryResultsPath, "utf-8"));
    DISCOVERY_DIMENSIONS.forEach((dim) => {
      discoveryResults[dim] = {};
      ["high", "low"].forEach((level) => {
        discoveryResults[dim][level] = {};
        DISCOVERY_CATEGORIES.forEach((cat) => {
          const flatKey = dim + capitalize(level) + capitalize(cat);
          const bullets = String(parsed[flatKey] || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          // renderInline (not render) -- these are single-line bullets, so
          // this keeps bold/italic/link support without wrapping each one
          // in a stray <p>.
          discoveryResults[dim][level][cat] = bullets.map((b) => mdRenderer.renderInline(b));
        });
      });
    });
  } catch (e) {
    console.warn(`Could not parse ${discoveryResultsPath}, using defaults:`, e.message);
  }
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify(
    { notionEntries, noteContent, articleLinks, learnWelcome, about, work, discoveryResults },
    null,
    0
  )
);

console.log(`Wrote ${notionEntries.length} articles to ${OUT_FILE}`);

// sitemap.xml + robots.txt: generated here rather than hand-maintained so
// articles added via the Notion sync show up automatically. Every article
// has a real URL (see src/worker.js's ARTICLE_PATH and routeFromLocation in
// public/index.html), which is what makes them individually crawlable.
const SITE_ORIGIN = "https://mutaremores.com";
const staticPaths = ["/", "/about", "/work", "/assessment", "/learn"];
const urls = [
  ...staticPaths.map((p) => ({ loc: SITE_ORIGIN + p, lastmod: null })),
  ...ordered.map((p, i) => ({
    loc: `${SITE_ORIGIN}/learn/${notionEntries[i].slug}`,
    lastmod: /^\d{4}-\d{2}-\d{2}$/.test(String(p.data.lastEdited || ""))
      ? String(p.data.lastEdited)
      : null,
  })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`
  )
  .join("\n")}
</urlset>
`;
fs.writeFileSync(path.resolve("public/sitemap.xml"), sitemap);
fs.writeFileSync(
  path.resolve("public/robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`
);
console.log(`Wrote sitemap.xml (${urls.length} urls) and robots.txt`);
