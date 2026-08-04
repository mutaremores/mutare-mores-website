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

const mdRenderer = new MarkdownIt({ html: true, linkify: true });

function htmlFromMarkdown(str) {
  if (!str) return "";
  return mdRenderer.render(str).trim();
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
    // The CMS's own entry identifier (filename minus .md), needed to link
    // straight from public/admin/browse.html into this article's editor at
    // /admin/#/collections/article/entries/<slug>.
    slug: p.file.replace(/\.md$/, ""),
  });

  const notesHtml = htmlFromMarkdown(p.body);
  noteContent.push({
    tldr: htmlFromMarkdown(d.tldr || ""),
    notes: notesHtml,
    resources: htmlFromMarkdown(d.resources || ""),
    // "Has this been written up?" is derived from the body field itself
    // now, not a separate manual checkbox — if there's real body content,
    // it's written up.
    has: !!(p.body && p.body.trim()),
  });

  articleLinks.push({
    last: d.lastEdited || "",
  });
}

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

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify(
    { notionEntries, noteContent, articleLinks, learnWelcome, about, work },
    null,
    0
  )
);

console.log(`Wrote ${notionEntries.length} articles to ${OUT_FILE}`);
