// Pulls content from Notion (the owner's new writing surface) and commits
// it straight to GitHub in the same content/articles + content/settings
// shape scripts/build-articles-json.mjs already reads -- so the existing,
// unchanged build pipeline picks it up with no site-side changes. Runs
// once a day on a Cron Trigger (see src/worker.js's scheduled handler) and
// on-demand via the /notion-sync/trigger route.
//
// No npm dependencies (no gray-matter/js-yaml) -- Workers Builds' bundling
// setup was never verified locally in this environment (no node/wrangler
// available), so this hand-rolls its own tiny YAML frontmatter writer/
// reader rather than risk an unverifiable bundler surprise. The YAML it
// writes just needs to be valid, standard YAML; gray-matter/js-yaml parse
// it fine on the build side regardless of how it was produced.

const GITHUB_REPO = "mutaremores/mutare-mores-website";
const GITHUB_BRANCH = "main";
const MANIFEST_PATH = "content/settings/notion-sync-manifest.json";
const NOTION_VERSION = "2022-06-28";

// ---------- Notion API ----------

async function notionFetch(ctx, path, options = {}) {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ctx.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Notion API ${path} failed: ${resp.status} ${body}`);
  }
  return resp.json();
}

async function queryDatabase(ctx, databaseId) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(ctx, `/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function getBlockChildren(ctx, blockId) {
  let results = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notionFetch(ctx, `/blocks/${blockId}/children?${qs}`);
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

function getTitleProp(page) {
  for (const key of Object.keys(page.properties)) {
    const p = page.properties[key];
    if (p.type === "title") return p.title.map((t) => t.plain_text).join("").trim();
  }
  return "";
}

// ---------- Rich text -> markdown ----------

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
      if (rt.href) s = `[${s}](${rt.href})`;
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

async function renderBlock(ctx, block, indent, depth) {
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
      const path = await rehostImage(ctx, block);
      line = indent + `![](${path})`;
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
    const children = await getBlockChildren(ctx, block.id);
    const childDepth = isListItemType(t) || t === "toggle" ? depth + 1 : depth;
    const childMd = await blocksToMarkdown(ctx, children, childDepth);
    if (childMd) line += "\n" + childMd;
  }

  return line;
}

async function blocksToMarkdown(ctx, blocks, depth = 0) {
  const indent = "  ".repeat(depth);
  const out = [];
  let prevWasListItem = false;
  for (const block of blocks) {
    const isListItem = isListItemType(block.type);
    const rendered = await renderBlock(ctx, block, indent, depth);
    if (rendered === null) continue;
    if (out.length && (!isListItem || !prevWasListItem)) out.push("");
    out.push(rendered);
    prevWasListItem = isListItem;
  }
  return out.join("\n");
}

async function collectToggleItems(ctx, blocks) {
  const items = [];
  for (const block of blocks) {
    if (!isToggleSection(block)) continue;
    const summary = toggleSectionText(block);
    let body = "";
    if (block.has_children) {
      const children = await getBlockChildren(ctx, block.id);
      body = await blocksToMarkdown(ctx, children, 0);
    }
    items.push({ summary, body: body.trim() });
  }
  return items;
}

async function collectColumnsItems(ctx, columnListBlockId) {
  const columns = await getBlockChildren(ctx, columnListBlockId);
  const result = [];
  for (const col of columns) {
    const colChildren = await getBlockChildren(ctx, col.id);
    let title = "";
    const itemBlocks = [];
    for (const b of colChildren) {
      if (!title && /^heading_/.test(b.type)) {
        title = richTextToMarkdown(b[b.type].rich_text).trim();
      } else {
        itemBlocks.push(b);
      }
    }
    const items = await collectToggleItems(ctx, itemBlocks);
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

async function rehostImage(ctx, block) {
  const img = block.image;
  if (img.type === "external") return img.external.url;

  const existing = ctx.manifest.data.images[block.id];
  if (existing) return "/" + existing.replace(/^public\//, "");

  const url = img.file.url;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download Notion image ${block.id}: ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const ext = extFromContentType(resp.headers.get("content-type")) || extFromUrl(url) || "png";
  const repoPath = `public/images/notion-sync/${block.id}.${ext}`;

  await ghPutFile(ctx, repoPath, bytes, `Notion sync: add image ${block.id}`, undefined);
  ctx.manifest.data.images[block.id] = repoPath;
  return "/" + repoPath.replace(/^public\//, "");
}

// ---------- GitHub API ----------

async function ghRequest(ctx, path, options = {}) {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ctx.env.GITHUB_SYNC_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mutare-mores-notion-sync",
      ...(options.headers || {}),
    },
  });
}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  return b64EncodeBytes(bytes);
}

function b64EncodeBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghGetFile(ctx, path) {
  const resp = await ghRequest(ctx, `/contents/${path}?ref=${GITHUB_BRANCH}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub GET ${path} failed: ${resp.status}`);
  const data = await resp.json();
  return { sha: data.sha, content: b64DecodeUtf8(data.content) };
}

async function ghPutFile(ctx, path, content, message, sha) {
  const contentB64 = content instanceof Uint8Array ? b64EncodeBytes(content) : b64EncodeUtf8(content);
  const body = { message, content: contentB64, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const resp = await ghRequest(ctx, `/contents/${path}`, { method: "PUT", body: JSON.stringify(body) });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GitHub PUT ${path} failed: ${resp.status} ${errBody}`);
  }
  return resp.json();
}

async function writeIfChanged(ctx, path, newContent, message) {
  const existing = await ghGetFile(ctx, path);
  if (existing && existing.content === newContent) return { changed: false };
  await ghPutFile(ctx, path, newContent, message, existing?.sha);
  return { changed: true, created: !existing };
}

async function listArticleFiles(ctx) {
  const resp = await ghRequest(ctx, `/git/trees/${GITHUB_BRANCH}?recursive=1`);
  if (!resp.ok) throw new Error(`Failed to list repo tree: ${resp.status}`);
  const data = await resp.json();
  return data.tree
    .filter((e) => e.type === "blob" && e.path.startsWith("content/articles/") && e.path.endsWith(".md"))
    .map((e) => e.path.replace("content/articles/", ""));
}

// ---------- Frontmatter (hand-rolled, no js-yaml) ----------

function yamlScalar(s) {
  const str = String(s);
  if (
    str === "" ||
    /^\s|\s$/.test(str) ||
    /[:#[\]{}",'\n]/.test(str) ||
    /^(true|false|null|~)$/i.test(str) ||
    /^[-\d]/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

function yamlBlockScalar(s) {
  const lines = String(s).replace(/\r\n/g, "\n").split("\n");
  return "|\n" + lines.map((l) => "  " + l).join("\n") + "\n";
}

function buildFrontmatter(fm) {
  let out = "";
  for (const [key, val] of Object.entries(fm)) {
    if (val === undefined || val === null) continue;
    if (key === "firstPublished" || key === "lastEdited") {
      out += `${key}: ${val}\n`;
    } else if (Array.isArray(val)) {
      if (!val.length) {
        out += `${key}: []\n`;
      } else {
        out += `${key}:\n`;
        for (const item of val) out += `  - ${yamlScalar(item)}\n`;
      }
    } else if (typeof val === "string" && val.includes("\n")) {
      out += `${key}: ${yamlBlockScalar(val)}`;
    } else {
      out += `${key}: ${yamlScalar(val)}\n`;
    }
  }
  return out;
}

function unquoteYaml(s) {
  const str = s.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    try {
      return JSON.parse(str.startsWith("'") ? `"${str.slice(1, -1).replace(/"/g, '\\"')}"` : str);
    } catch {
      return str.slice(1, -1);
    }
  }
  return str;
}

function parseFrontmatter(fileContent) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fileContent);
  if (!m) return null;
  const body = m[1];
  const fm = {};
  const titleMatch = /^title:\s*(.+)$/m.exec(body);
  if (titleMatch) fm.title = unquoteYaml(titleMatch[1]);
  const origIndexMatch = /^origIndex:\s*(\d+)\s*$/m.exec(body);
  if (origIndexMatch) fm.origIndex = Number(origIndexMatch[1]);
  const firstPublishedMatch = /^firstPublished:\s*(\S+)\s*$/m.exec(body);
  if (firstPublishedMatch) fm.firstPublished = firstPublishedMatch[1].trim();
  return fm;
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

async function loadManifest(ctx) {
  const file = await ghGetFile(ctx, MANIFEST_PATH);
  if (!file) return { sha: null, data: { articles: {}, images: {} } };
  const data = JSON.parse(file.content);
  if (!data.articles) data.articles = {};
  if (!data.images) data.images = {};
  return { sha: file.sha, data };
}

async function saveManifestIfChanged(ctx, manifest, originalJson) {
  const newJson = JSON.stringify(manifest.data, null, 2);
  if (newJson === originalJson) return;
  await ghPutFile(ctx, MANIFEST_PATH, newJson, "Update Notion sync manifest", manifest.sha);
}

// Matches existing content/articles/*.md files to Notion pages by exact
// title, for any Notion page not yet in the manifest -- without this, the
// first sync run would create brand-new duplicate files for every article
// the owner already migrated into Notion, instead of updating the
// Decap-authored file that article came from.
async function bootstrapManifestFromExistingFiles(ctx, manifest, notionPages) {
  const unmatchedPages = notionPages.filter((p) => !manifest.data.articles[p.id]);
  if (!unmatchedPages.length) return;

  const alreadyMapped = new Set(Object.values(manifest.data.articles));
  const filenames = (await listArticleFiles(ctx)).filter((f) => !alreadyMapped.has(f));
  if (!filenames.length) return;

  const titleIndex = new Map();
  for (const filename of filenames) {
    const file = await ghGetFile(ctx, `content/articles/${filename}`);
    if (!file) continue;
    const fm = parseFrontmatter(file.content);
    if (fm?.title) titleIndex.set(fm.title.trim().toLowerCase(), filename);
  }

  for (const page of unmatchedPages) {
    const key = getTitleProp(page).trim().toLowerCase();
    const match = titleIndex.get(key);
    if (match) {
      manifest.data.articles[page.id] = match;
      titleIndex.delete(key);
    }
  }
}

// ---------- Article sync ----------

async function buildArticleContent(ctx, pageId) {
  const topBlocks = await getBlockChildren(ctx, pageId);
  const sections = { tldr: "", notes: "", resources: "" };
  const nameMap = { "tl;dr": "tldr", notes: "notes", "external resources": "resources" };
  for (const block of topBlocks) {
    if (block.type !== "heading_2") continue;
    const heading = richTextToMarkdown(block.heading_2.rich_text).trim().toLowerCase();
    const key = nameMap[heading];
    if (key && block.has_children) {
      const children = await getBlockChildren(ctx, block.id);
      sections[key] = await blocksToMarkdown(ctx, children, 0);
    }
  }
  return sections;
}

async function syncArticles(ctx, summary) {
  const manifest = ctx.manifest;
  const pages = (await queryDatabase(ctx, ctx.env.NOTION_ARTICLES_DB_ID)).filter((p) => !p.archived);

  await bootstrapManifestFromExistingFiles(ctx, manifest, pages);

  for (const page of pages) {
    const title = getTitleProp(page);
    if (!title) continue;

    let filename = manifest.data.articles[page.id];
    let existingFile = filename ? await ghGetFile(ctx, `content/articles/${filename}`) : null;
    const existingFm = existingFile ? parseFrontmatter(existingFile.content) || {} : {};

    if (!filename) {
      filename = articleFilename(title, page.created_time);
      manifest.data.articles[page.id] = filename;
    }

    const status = getProp(page, "Progress") || "Not started";
    const category = getProp(page, "Category");
    const sources = getProp(page, "Sources") || [];
    const topics = getProp(page, "Topics") || [];
    const firstPublished =
      existingFm.firstPublished || (getProp(page, "First edit") || page.created_time).slice(0, 10);
    const lastEdited = (getProp(page, "Last edit") || page.last_edited_time).slice(0, 10);

    const sections = await buildArticleContent(ctx, page.id);

    const fm = { title, status };
    if (category) fm.category = category;
    fm.sources = sources;
    fm.topics = topics;
    if (existingFm.origIndex !== undefined) fm.origIndex = existingFm.origIndex;
    fm.firstPublished = firstPublished;
    fm.lastEdited = lastEdited;
    if (sections.tldr.trim()) fm.tldr = sections.tldr.trim();
    if (sections.resources.trim()) fm.resources = sections.resources.trim();

    const fileContent = `---\n${buildFrontmatter(fm)}---\n${sections.notes.trim()}\n`;
    if (existingFile && existingFile.content === fileContent) continue;

    await ghPutFile(
      ctx,
      `content/articles/${filename}`,
      fileContent,
      `Notion sync: update "${title}"`,
      existingFile?.sha
    );
    summary.articles.push({ title, filename, created: !existingFile });
  }
}

// ---------- About page sync ----------

async function syncAboutPage(ctx, summary) {
  const blocks = await getBlockChildren(ctx, ctx.env.NOTION_ABOUT_PAGE_ID);
  const sections = [];
  for (const block of blocks) {
    if (!isToggleSection(block)) continue;
    const heading = toggleSectionText(block);
    let body = "";
    if (block.has_children) {
      const children = await getBlockChildren(ctx, block.id);
      body = await blocksToMarkdown(ctx, children, 0);
    }
    sections.push({ heading, body: body.trim() });
  }
  const json = JSON.stringify({ sections }, null, 2);
  const result = await writeIfChanged(ctx, "content/settings/about.json", json, "Notion sync: update About page");
  if (result.changed) summary.settings.push("about.json");
}

// ---------- Work With Me page sync ----------

async function syncWorkPage(ctx, summary) {
  const blocks = await getBlockChildren(ctx, ctx.env.NOTION_WORK_PAGE_ID);

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
    whatIDo: whatIDoSeg ? (await blocksToMarkdown(ctx, whatIDoSeg.blocks, 0)).trim() : "",
    discoveryCall: discoverySeg ? (await blocksToMarkdown(ctx, discoverySeg.blocks, 0)).trim() : "",
    columns: [],
    workOnOutro: "",
    faq: faqSeg ? await collectToggleItems(ctx, faqSeg.blocks) : [],
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
    if (colListBlock) work.columns = await collectColumnsItems(ctx, colListBlock.id);
    const trailingParas = columnsSeg.blocks.filter((b) => b.type === "paragraph");
    work.workOnOutro = (await blocksToMarkdown(ctx, trailingParas, 0)).trim();
  }

  const json = JSON.stringify(work, null, 2);
  const result = await writeIfChanged(ctx, "content/settings/work.json", json, "Notion sync: update Work With Me page");
  if (result.changed) summary.settings.push("work.json");
}

// ---------- Entry point ----------

export async function runSync(env) {
  const summary = { articles: [], settings: [], errors: [] };
  const manifest = await loadManifest({ env });
  const originalManifestJson = JSON.stringify(manifest.data, null, 2);
  const ctx = { env, manifest };

  try {
    await syncArticles(ctx, summary);
  } catch (e) {
    summary.errors.push(`Articles sync failed: ${e.message}`);
  }
  try {
    await syncAboutPage(ctx, summary);
  } catch (e) {
    summary.errors.push(`About sync failed: ${e.message}`);
  }
  try {
    await syncWorkPage(ctx, summary);
  } catch (e) {
    summary.errors.push(`Work sync failed: ${e.message}`);
  }

  try {
    await saveManifestIfChanged(ctx, manifest, originalManifestJson);
  } catch (e) {
    summary.errors.push(`Manifest save failed: ${e.message}`);
  }

  return summary;
}
