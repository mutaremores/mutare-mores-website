import json, re, os
from markdownify import markdownify as md

SRC = '/tmp/index.html'
OUT_DIR = '/tmp/tina-site/content/articles'

with open(SRC, encoding='utf-8') as f:
    content = f.read()

m = re.search(r'const notionEntries = (\[.*?\]);', content, re.DOTALL)
notion_entries = json.loads(m.group(1))
m2 = re.search(r'const noteContent = (\[.*?\]);', content, re.DOTALL)
note_content = json.loads(m2.group(1))
m3 = re.search(r'const articleLinks = (\[.*?\]);', content, re.DOTALL)
article_links = json.loads(m3.group(1))

assert len(notion_entries) == len(note_content) == len(article_links)

def slugify(title, idx):
    s = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    s = s[:60].rstrip('-')
    return f"{idx:04d}-{s}" if s else f"{idx:04d}-untitled"

def html_to_md(html):
    if not html:
        return ""
    return md(html, heading_style="ATX").strip()

def yaml_str(s):
    if s is None:
        return "null"
    s = str(s)
    return "'" + s.replace("'", "''").replace("\n", "\\n") + "'"

def yaml_block_str(s):
    # Block scalar for multi-line text fields (tldr/resources), safe for
    # arbitrary content without escaping headaches.
    if not s:
        return "''"
    indented = "\n".join("  " + line for line in s.split("\n"))
    return "|\n" + indented

def yaml_list(items):
    if not items:
        return "[]"
    return "[" + ", ".join(yaml_str(i) for i in items) + "]"

def yaml_num_list(items):
    if not items:
        return "[]"
    return "[" + ", ".join(str(int(i)) for i in items) + "]"

os.makedirs(OUT_DIR, exist_ok=True)
index = []

for idx, (entry, note, links) in enumerate(zip(notion_entries, note_content, article_links)):
    slug = slugify(entry['t'], idx)
    fname = f"{slug}.md"

    tldr_md = html_to_md(note.get('tldr'))
    resources_md = html_to_md(note.get('resources'))
    notes_md = html_to_md(note.get('notes'))

    fm_lines = [
        "---",
        f"origIndex: {idx}",
        f"title: {yaml_str(entry['t'])}",
        f"category: {yaml_str(entry['cat'])}",
        f"topics: {yaml_list(entry.get('topics', []))}",
        f"sources: {yaml_list(entry.get('src', []))}",
        f"status: {yaml_str(entry['prog'])}",
        f"firstPublished: {yaml_str(entry['first'])}",
        f"lastEdited: {yaml_str(links.get('last', ''))}",
        f"hasContent: {'true' if note.get('has') else 'false'}",
        f"relatedOut: {yaml_num_list(links.get('out', []))}",
        f"relatedIn: {yaml_num_list(links.get('in', []))}",
        f"tldr: {yaml_block_str(tldr_md)}",
        f"resources: {yaml_block_str(resources_md)}",
        "---",
    ]

    with open(os.path.join(OUT_DIR, fname), 'w', encoding='utf-8') as out:
        out.write("\n".join(fm_lines) + "\n\n" + notes_md + "\n")

    index.append({"idx": idx, "file": fname})

with open('/tmp/tina-site/content/_index-map.json', 'w', encoding='utf-8') as f:
    json.dump(index, f, indent=2)

print(f"Wrote {len(index)} article files to {OUT_DIR}")
