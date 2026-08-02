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

// Build a map from legacy origIndex -> new position, so relatedOut/relatedIn
// (which reference legacy indexes) can be translated to the new array
// positions. New articles (no origIndex) can't be targets of legacy
// relations, which is fine — those links were only ever generated for the
// original stub set.
const legacyIndexToNewPos = new Map();
ordered.forEach((p, newPos) => {
  if (Number.isInteger(p.data.origIndex)) {
    legacyIndexToNewPos.set(p.data.origIndex, newPos);
  }
});

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
  });

  const notesHtml = htmlFromMarkdown(p.body);
  noteContent.push({
    tldr: htmlFromMarkdown(d.tldr || ""),
    notes: notesHtml,
    resources: htmlFromMarkdown(d.resources || ""),
    // Trust the editor's own "Has been written up?" checkbox exactly — some
    // not-yet-written stubs carry leftover placeholder text (e.g. "Explain")
    // in their body, so inferring "has content" from a non-empty body would
    // wrongly flip those to written.
    has: !!d.hasContent,
  });

  const out = (d.relatedOut || [])
    .map((legacyIdx) => legacyIndexToNewPos.get(legacyIdx))
    .filter((v) => v !== undefined);
  const inn = (d.relatedIn || [])
    .map((legacyIdx) => legacyIndexToNewPos.get(legacyIdx))
    .filter((v) => v !== undefined);

  articleLinks.push({
    out,
    in: inn,
    last: d.lastEdited || "",
  });
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify({ notionEntries, noteContent, articleLinks }, null, 0)
);

console.log(`Wrote ${notionEntries.length} articles to ${OUT_FILE}`);
