// Pulls content from Notion (the owner's writing surface) and writes it
// straight into content/articles + content/settings in the same shape
// scripts/build-articles-json.mjs already reads -- so that existing,
// unchanged build script picks it up with no site-side changes. Runs as a
// GitHub Action (see .github/workflows/notion-sync.yml), not on
// Cloudflare -- a full sync legitimately needs more outbound API calls
// than the Workers Free plan's 50-subrequest-per-request cap allows, and
// running as a plain Node script here sidesteps that entirely: this
// process just reads/writes files on the runner's checked-out copy of the
// repo, and the workflow commits+pushes whatever changed.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2022-06-28";

const NOTION_ARTICLES_DB_ID = "dcab6984-6bb3-82a5-b66d-813c8a6ac6c1";
const NOTION_ABOUT_PAGE_ID = "af2b6984-6bb3-8324-8087-0179368fe622";
const NOTION_WORK_PAGE_ID = "f6db6984-6bb3-828b-80a5-012e0d1bc5fe";

const ARTICLES_DIR = path.resolve("content/articles");
const SETTINGS_DIR = path.resolve("content/settings");
const IMAGES_DIR = path.resolve("public/images/notion-sync");
const MANIFEST_PATH = path.join(SETTINGS_DIR, "notion-sync-manifest.json");

if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN environment variable");
  process.exit(1);
}

// ---------- Notion API ----------

async function notionFetch(apiPath, options = {}) {
  const resp = await fetch(`https://api.notion.com/v1${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Notion API ${apiPath} failed: ${resp.status} ${body}`);
  }
  return resp.json();
}

async function queryDatabase(databaseId) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function getBlockChildren(blockId) {
  let results = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notionFetch(`/blocks/${blockId}/children?${qs}`);
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function getProp(page, name) {
  const p = page.properties[name];
  if (!p) return null;
  switch (p.type) {
    case "title":
      return p.title.map((t) => t.plain_text).join("");
    case "rich_text":
      return p.rich_text.map((t) => t.plain_text).join("");
    case "select":
      return p.select ? p.select.name : null;
    case "status":
      return p.status ? p.status.name : null;
    case "multi_select":
      return p.multi_select.map((o) => o.name);
    case "created_time":
      return p.created_time;
    case "last_edited_time":
      return p.last_edited_time;
    case "date":
      return p.date ? p.date.start : null;
    default:
      return null;
  }
}

// Hand-rolled frontmatter writer, used instead of matter.stringify().
// js-yaml's dump() auto-picks a scalar style per value, and for some
// multi-line markdown content (e.g. a line starting with "**Bold**" or
// containing a bare colon) it was choosing plain/quoted style instead of
// a literal block, producing YAML matter() itself couldn't parse back
// (confirmed against real synced content -- "unidentified alias" and
// "document separator expected" errors). Always forcing block-literal
// style for any multi-line string sidesteps that entirely: block
// literals preserve text verbatim, no special-character interpretation.
function yamlScalar(s) {
  const str = String(s);
  if (
    str === "" ||
    /^\s|\s$/.test(str) ||
    /[:#[\]{}",'\n]/.test(str) ||
    /^(true|false|null|~)$/i.test(str) ||
    /^[-*&!|>%@`\d]/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

function yamlBlockScalar(s) {
  const lines = String(s).replace(/\r\n/g, "\n").split("\n");
  return "|\n" + lines.map((l) => (l ? "  " + l : "")).join("\n") + "\n";
}

function buildFrontmatter(fm) {
  let out = "";
  for (const [key, val] of Object.entries(fm)) {
    if (val === undefined || val === null) continue;
    if (key === "firstPublished" || key === "lastEdited") {
      // Quoted deliberately -- an unquoted bare date (2026-07-29) is
      // YAML's !!timestamp type, which js-yaml parses into a real JS
      // Date object. build-articles-json.mjs's real gray-matter parser
      // hit exactly that: String(dateObj).slice(0,10) produced "Wed Jul
      // 29" instead of "2026-07-29" on the live site. Quoting keeps it a
      // plain string on read-back.
      out += `${key}: '${val}'\n`;
    } else if (Array.isArray(val)) {
      if (!val.length) {
        out += `${key}: []\n`;
      } else {
        out += `${key}:\n`;
        for (const item of val) out += `  - ${yamlScalar(item)}\n`;
      }
    } else if (typeof val === "string" && val.includes("\n")) {
      out += `${key}: ${yamlBlockScalar(val)}`;
    } else if (typeof val === "number") {
      // Real numbers (origIndex) must stay bare, unquoted digits --
      // yamlScalar's leading-digit check exists to quote strings that
      // happen to start with a digit, not to stringify actual numbers,
      // which build-articles-json.mjs checks with Number.isInteger().
      out += `${key}: ${val}\n`;
    } else {
      out += `${key}: ${yamlScalar(val)}\n`;
    }
  }
  return out;
}

// gray-matter/js-yaml parses an unquoted bare date scalar (e.g.
// `firstPublished: 2026-07-29`, which several legacy-migrated articles
// have) into a real JS Date object, not a string -- re-stringifying that
// unchanged would balloon it into a full ISO timestamp. Preserved date
// values are normalized back to plain YYYY-MM-DD through this before
// going into the frontmatter object handed to matter.stringify.
function formatDateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function getTitleProp(page) {
  for (const key of Object.keys(page.properties)) {
    const p = page.properties[key];
    if (p.type === "title") return p.title.map((t) => t.plain_text).join("").trim();
  }
  return "";
}

// ---------- Rich text -> markdown ----------

// When you link one article to another in Notion (typing @ and picking a
// page, or selecting text and using "Link to page"), Notion gives that
// link an href pointing at its own page -- either a relative
// "/p/<32 hex chars>" or a full notion.so URL, always ending in the
// target page's id with the dashes stripped. If that id belongs to one
// of our synced articles, the link needs to become the site's own
// article:<slug> href (see public/index.html's slugToPos) instead of a
// dead Notion path -- otherwise clicking it 404s or, on some setups,
// downloads a Notion export instead of navigating.
function articleSlugFromHref(href) {
  const m = /([0-9a-f]{32})(?:[/?#]|$)/i.exec(href);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  const pageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const filename = manifest.articles[pageId];
  return filename ? filename.replace(/\.md$/, "") : null;
}

function richTextToMarkdown(richText) {
  if (!richText || !richText.length) return "";
  return richText
    .map((rt) => {
      let s = rt.plain_text || "";
      if (!s) return s;
      if (rt.annotations?.code) s = `\`${s}\``;
      if (rt.annotations?.bold) s = `**${s}**`;
      if (rt.annotations?.italic) s = `*${s}*`;
      if (rt.annotations?.strikethrough) s = `~~${s}~~`;
      if (rt.href) {
        const articleSlug = articleSlugFromHref(rt.href);
        s = articleSlug ? `[${s}](article:${articleSlug})` : `[${s}](${rt.href})`;
      }
      return s;
    })
    .join("");
}

// ---------- Blocks -> markdown ----------

function isListItemType(t) {
  return t === "bulleted_list_item" || t === "numbered_list_item" || t === "to_do";
}

function isToggleSection(block) {
  return (
    block.type === "toggle" ||
    (block.type.startsWith("heading_") && block[block.type].is_toggleable)
  );
}

function toggleSectionText(block) {
  return richTextToMarkdown(block[block.type].rich_text).trim();
}

async function renderBlock(block, indent, depth) {
  const t = block.type;
  const data = block[t];
  const rt = data?.rich_text;
  let line;

  switch (t) {
    case "paragraph": {
      const text = richTextToMarkdown(rt);
      if (!text.trim()) return null;
      line = indent + text;
      break;
    }
    case "bulleted_list_item": {
      const text = richTextToMarkdown(rt);
      if (!text.trim() && !block.has_children) return null;
      line = indent + "- " + text;
      break;
    }
    case "numbered_list_item": {
      const text = richTextToMarkdown(rt);
      if (!text.trim() && !block.has_children) return null;
      line = indent + "1. " + text;
      break;
    }
    case "to_do": {
      const text = richTextToMarkdown(rt);
      if (!text.trim() && !block.has_children) return null;
      line = indent + `- [${data.checked ? "x" : " "}] ` + text;
      break;
    }
    case "quote":
      line = indent + "> " + richTextToMarkdown(rt);
      break;
    case "divider":
      line = indent + "---";
      break;
    case "heading_1":
      line = indent + "# " + richTextToMarkdown(rt);
      break;
    case "heading_2":
      line = indent + "## " + richTextToMarkdown(rt);
      break;
    case "heading_3":
      line = indent + "### " + richTextToMarkdown(rt);
      break;
    case "code": {
      const lang = data.language || "";
      const text = rt.map((r) => r.plain_text).join("");
      line = `${indent}\`\`\`${lang}\n${text}\n${indent}\`\`\``;
      break;
    }
    case "image": {
      const imgPath = await rehostImage(block);
      line = indent + `![](${imgPath})`;
      break;
    }
    case "toggle":
      // A toggle reached here is nested inside body content, not one of
      // the section/FAQ/column markers the callers already peeled off --
      // render it as bold text with its children indented beneath.
      line = indent + `**${richTextToMarkdown(rt)}**`;
      break;
    default:
      // Unsupported block types (columns encountered outside the "Things
      // we can work on" layout, embeds, etc.) are silently skipped.
      return null;
  }

  if (block.has_children && t !== "image") {
    const children = await getBlockChildren(block.id);
    const childDepth = isListItemType(t) || t === "toggle" ? depth + 1 : depth;
    const childMd = await blocksToMarkdown(children, childDepth);
    if (childMd) line += "\n" + childMd;
  }

  return line;
}

async function blocksToMarkdown(blocks, depth = 0) {
  const indent = "  ".repeat(depth);
  const out = [];
  let prevWasListItem = false;
  for (const block of blocks) {
    const isListItem = isListItemType(block.type);
    const rendered = await renderBlock(block, indent, depth);
    if (rendered === null) continue;
    if (out.length && (!isListItem || !prevWasListItem)) out.push("");
    out.push(rendered);
    prevWasListItem = isListItem;
  }
  return out.join("\n");
}

async function collectToggleItems(blocks) {
  const items = [];
  for (const block of blocks) {
    if (!isToggleSection(block)) continue;
    const summary = toggleSectionText(block);
    let body = "";
    if (block.has_children) {
      const children = await getBlockChildren(block.id);
      body = await blocksToMarkdown(children, 0);
    }
    items.push({ summary, body: body.trim() });
  }
  return items;
}

async function collectColumnsItems(columnListBlockId) {
  const columns = await getBlockChildren(columnListBlockId);
  const result = [];
  for (const col of columns) {
    const colChildren = await getBlockChildren(col.id);
    let title = "";
    const itemBlocks = [];
    for (const b of colChildren) {
      if (!title && /^heading_/.test(b.type)) {
        title = richTextToMarkdown(b[b.type].rich_text).trim();
      } else {
        itemBlocks.push(b);
      }
    }
    const items = await collectToggleItems(itemBlocks);
    result.push({ title, items });
  }
  return result;
}

// ---------- Image re-hosting ----------

function extFromContentType(ct) {
  if (!ct) return null;
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("svg")) return "svg";
  return null;
}

function extFromUrl(url) {
  try {
    const m = /\.([a-zA-Z0-9]+)(?:$)/.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function rehostImage(block) {
  const img = block.image;
  if (img.type === "external") return img.external.url;

  const existing = manifest.images[block.id];
  if (existing) return "/" + existing.replace(/^public\//, "");

  const url = img.file.url;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download Notion image ${block.id}: ${resp.status}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  const ext = extFromContentType(resp.headers.get("content-type")) || extFromUrl(url) || "png";
  const filename = `${block.id}.${ext}`;
  const repoPath = `public/images/notion-sync/${filename}`;

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGES_DIR, filename), bytes);
  manifest.images[block.id] = repoPath;
  return "/" + repoPath.replace(/^public\//, "");
}

// ---------- Slug / filename ----------

function slugifyTitle(title) {
  return (
    String(title || "untitled")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function articleFilename(title, createdIso) {
  const d = new Date(createdIso);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${stamp}-${slugifyTitle(title)}.md`;
}

// ---------- Manifest ----------

let manifest = { articles: {}, images: {} };

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    manifest = { articles: parsed.articles || {}, images: parsed.images || {} };
  }
}

function saveManifest() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// Matches existing content/articles/*.md files to Notion pages by exact
// title, for any Notion page not yet in the manifest -- without this, the
// first sync run would create brand-new duplicate files for every article
// the owner already migrated into Notion, instead of updating the file
// that article came from.
function bootstrapManifestFromExistingFiles(notionPages) {
  const unmatchedPages = notionPages.filter((p) => !manifest.articles[p.id]);
  if (!unmatchedPages.length) return;

  const alreadyMapped = new Set(Object.values(manifest.articles));
  const filenames = fs
    .readdirSync(ARTICLES_DIR)
    .filter((f) => f.endsWith(".md") && !alreadyMapped.has(f));
  if (!filenames.length) return;

  const titleIndex = new Map();
  for (const filename of filenames) {
    const raw = fs.readFileSync(path.join(ARTICLES_DIR, filename), "utf-8");
    const { data } = matter(raw);
    if (data.title) titleIndex.set(String(data.title).trim().toLowerCase(), filename);
  }

  for (const page of unmatchedPages) {
    const key = getTitleProp(page).trim().toLowerCase();
    const match = titleIndex.get(key);
    if (match) {
      manifest.articles[page.id] = match;
      titleIndex.delete(key);
    }
  }
}

// ---------- Article sync ----------

// TL;DR / Notes / External Resources are heading_2 blocks, but not
// necessarily toggles -- most migrated articles have them as plain
// headings with the section's bullets as following siblings, not
// children. Handles both shapes: a toggleable heading's content comes
// from its children directly, otherwise everything up to the next
// heading_2 is collected as that section's content.
async function buildArticleContent(pageId) {
  const topBlocks = await getBlockChildren(pageId);
  const nameMap = { "tl;dr": "tldr", notes: "notes", "external resources": "resources" };
  const sections = { tldr: "", notes: "", resources: "" };

  let currentKey = null;
  let buf = [];
  const flushSiblings = async () => {
    if (currentKey && buf.length) {
      const md = await blocksToMarkdown(buf, 0);
      if (md) sections[currentKey] = md;
    }
    buf = [];
  };

  for (const block of topBlocks) {
    if (block.type === "heading_2") {
      await flushSiblings();
      const heading = richTextToMarkdown(block.heading_2.rich_text).trim().toLowerCase();
      currentKey = nameMap[heading] || null;
      if (currentKey && block.has_children) {
        const children = await getBlockChildren(block.id);
        const md = await blocksToMarkdown(children, 0);
        if (md) sections[currentKey] = md;
        currentKey = null;
      }
      continue;
    }
    if (currentKey) buf.push(block);
  }
  await flushSiblings();

  return sections;
}

async function syncArticles(summary) {
  const pages = (await queryDatabase(NOTION_ARTICLES_DB_ID)).filter((p) => !p.archived);

  bootstrapManifestFromExistingFiles(pages);

  // Assign every page a filename up front, before building any content --
  // not just as each is reached in the loop below. articleSlugFromHref
  // needs the *target* article's manifest entry to already exist when
  // resolving a cross-link, and articles don't necessarily come back from
  // Notion in an order where a link's target has already been visited.
  for (const page of pages) {
    const title = getTitleProp(page);
    if (title && !manifest.articles[page.id]) {
      manifest.articles[page.id] = articleFilename(title, page.created_time);
    }
  }

  fs.mkdirSync(ARTICLES_DIR, { recursive: true });

  for (const page of pages) {
    const title = getTitleProp(page);
    if (!title) continue;

    try {
      const filename = manifest.articles[page.id];
      const filePath = path.join(ARTICLES_DIR, filename);
      const existingRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
      const existingParsed = existingRaw ? matter(existingRaw) : null;

      const status = getProp(page, "Progress") || "Not started";
      // Category is a Notion multi_select property, but the site's schema
      // (config.yml's article-category widget) only ever shows/stores one
      // value -- take the first, matching how the field is actually used.
      const categoryValues = getProp(page, "Category") || [];
      const category = categoryValues[0] || null;
      const sources = getProp(page, "Sources") || [];
      const topics = getProp(page, "Topics") || [];
      const firstPublished = existingParsed?.data.firstPublished
        ? formatDateOnly(existingParsed.data.firstPublished)
        : (getProp(page, "First edit") || page.created_time).slice(0, 10);
      const lastEdited = (getProp(page, "Last edit") || page.last_edited_time).slice(0, 10);

      const sections = await buildArticleContent(page.id);

      const fm = { title, status };
      if (category) fm.category = category;
      fm.sources = sources;
      fm.topics = topics;
      if (existingParsed?.data.origIndex !== undefined) {
        // Coerce back to a real number in case an earlier buggy run left
        // it quoted as a string (origIndex: "0") -- self-heals files
        // written before the numeric-scalar fix instead of perpetuating
        // the string forever.
        fm.origIndex = Number(existingParsed.data.origIndex);
      }
      fm.firstPublished = firstPublished;
      fm.lastEdited = lastEdited;
      if (sections.tldr.trim()) fm.tldr = sections.tldr.trim();
      if (sections.resources.trim()) fm.resources = sections.resources.trim();

      const fileContent = `---\n${buildFrontmatter(fm)}---\n${sections.notes.trim()}\n`;
      const outPath = path.join(ARTICLES_DIR, filename);
      if (existingRaw === fileContent) continue;

      fs.writeFileSync(outPath, fileContent);
      summary.articles.push({ title, filename, created: !existingRaw });
    } catch (e) {
      // One article's content shouldn't block every other article from
      // syncing -- record which one and why, and move on.
      summary.errors.push(`Article "${title}" failed: ${e.message}`);
    }
  }
}

// ---------- About page sync ----------

async function syncAboutPage(summary) {
  const blocks = await getBlockChildren(NOTION_ABOUT_PAGE_ID);
  const sections = [];
  for (const block of blocks) {
    if (!isToggleSection(block)) continue;
    const heading = toggleSectionText(block);
    let body = "";
    if (block.has_children) {
      const children = await getBlockChildren(block.id);
      body = await blocksToMarkdown(children, 0);
    }
    sections.push({ heading, body: body.trim() });
  }
  const outPath = path.join(SETTINGS_DIR, "about.json");
  const json = JSON.stringify({ sections }, null, 2) + "\n";
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : null;
  if (existing === json) return;
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(outPath, json);
  summary.settings.push("about.json");
}

// ---------- Work With Me page sync ----------

async function syncWorkPage(summary) {
  const blocks = await getBlockChildren(NOTION_WORK_PAGE_ID);

  const segments = [];
  let current = { heading: null, blocks: [] };
  for (const block of blocks) {
    if (block.type === "heading_2" && !block.heading_2.is_toggleable) {
      segments.push(current);
      current = { heading: richTextToMarkdown(block.heading_2.rich_text).trim(), blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  segments.push(current);

  const find = (name) => segments.find((s) => s.heading && s.heading.toLowerCase() === name.toLowerCase());

  const whatIDoSeg = find("What I do");
  const discoverySeg = find("The Discovery Call");
  const columnsSeg = find("Things we can work on");
  const faqSeg = find("What it's like to work with me") || find("What it’s like to work with me");

  const work = {
    whatIDo: whatIDoSeg ? (await blocksToMarkdown(whatIDoSeg.blocks, 0)).trim() : "",
    discoveryCall: discoverySeg ? (await blocksToMarkdown(discoverySeg.blocks, 0)).trim() : "",
    columns: [],
    workOnOutro: "",
    faq: faqSeg ? await collectToggleItems(faqSeg.blocks) : [],
  };

  // The site wires this phrase to a special in-page "jump to Learn room"
  // handler (see public/index.html's #linkLearnFromWork) rather than a
  // normal navigation -- a generic markdown link can't express that, so
  // any link whose text mentions "this website" gets swapped for the
  // exact anchor tag the site's JS looks up by id.
  work.whatIDo = work.whatIDo.replace(
    /\[([^\]]*this website[^\]]*)\]\([^)]*\)/i,
    '<a class="inline-link" id="linkLearnFromWork">$1</a>'
  );

  if (columnsSeg) {
    const colListBlock = columnsSeg.blocks.find((b) => b.type === "column_list");
    if (colListBlock) work.columns = await collectColumnsItems(colListBlock.id);
    const trailingParas = columnsSeg.blocks.filter((b) => b.type === "paragraph");
    work.workOnOutro = (await blocksToMarkdown(trailingParas, 0)).trim();
  }

  const outPath = path.join(SETTINGS_DIR, "work.json");
  const json = JSON.stringify(work, null, 2) + "\n";
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : null;
  if (existing === json) return;
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(outPath, json);
  summary.settings.push("work.json");
}

// ---------- Entry point ----------

async function main() {
  const summary = { articles: [], settings: [], errors: [] };
  loadManifest();

  // The workflow's `git add` step names this path explicitly, which
  // fails with "pathspec did not match any files" if it doesn't exist --
  // ensured unconditionally here so a run with no new images doesn't
  // break the commit step.
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  try {
    await syncArticles(summary);
  } catch (e) {
    summary.errors.push(`Articles sync failed: ${e.message}`);
  }
  try {
    await syncAboutPage(summary);
  } catch (e) {
    summary.errors.push(`About sync failed: ${e.message}`);
  }
  try {
    await syncWorkPage(summary);
  } catch (e) {
    summary.errors.push(`Work sync failed: ${e.message}`);
  }

  saveManifest();

  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) process.exitCode = 1;
}

main();
