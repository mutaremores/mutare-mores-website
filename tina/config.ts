import { defineConfig } from "tinacms";

// Tina Cloud credentials come from environment variables set in Netlify.
// Locally (`npx tinacms dev`), Tina runs against a local filesystem-backed
// server and these are not required.
const branch =
  process.env.GITHUB_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.HEAD ||
  "main";

export default defineConfig({
  branch,
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID || null,
  token: process.env.TINA_TOKEN || null,

  build: {
    outputFolder: "admin",
    publicFolder: "public",
  },
  media: {
    tina: {
      mediaRoot: "images",
      publicFolder: "public",
    },
  },

  schema: {
    collections: [
      {
        name: "article",
        label: "Learn Articles",
        path: "content/articles",
        format: "md",
        ui: {
          // Keep filenames stable/slugged; editors shouldn't need to think
          // about the filename.
          filename: {
            readonly: false,
            slugify: (values) => {
              const t = (values?.title || "untitled")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "")
                .slice(0, 60);
              return `${Date.now()}-${t}`;
            },
          },
        },
        fields: [
          { type: "number", name: "origIndex", label: "Legacy Index (internal)", ui: { component: "hidden" } },
          { type: "string", name: "title", label: "Title", isTitle: true, required: true },
          {
            type: "string",
            name: "category",
            label: "Category",
            options: ["Concepts", "Notes", "Thoughts", "Types"],
          },
          {
            type: "string",
            name: "topics",
            label: "Topics / Tags",
            list: true,
          },
          {
            type: "string",
            name: "sources",
            label: "Sources",
            list: true,
            options: ["Books", "Article", "Study", "Podcast", "Course"],
          },
          {
            type: "string",
            name: "status",
            label: "Status",
            options: ["Not started", "In progress", "Done"],
            required: true,
          },
          { type: "datetime", name: "firstPublished", label: "First Published", ui: { dateFormat: "YYYY-MM-DD" } },
          { type: "string", name: "lastEdited", label: "Last Edited (display, e.g. \"Aug 2\")" },
          { type: "boolean", name: "hasContent", label: "Has been written up?" },
          {
            type: "number",
            name: "relatedOut",
            label: "Related Article Indexes (legacy, internal)",
            list: true,
            ui: { component: "hidden" },
          },
          {
            type: "number",
            name: "relatedIn",
            label: "Linked-from Article Indexes (legacy, internal)",
            list: true,
            ui: { component: "hidden" },
          },
          {
            type: "string",
            name: "tldr",
            label: "TL;DR (short summary, shown at the top of the article)",
            ui: { component: "textarea" },
          },
          {
            type: "rich-text",
            name: "notes",
            label: "Notes (main article body — headers, bold, bullet lists, links all supported)",
            isBody: true,
          },
          {
            type: "string",
            name: "resources",
            label: "Resources",
            ui: { component: "textarea" },
          },
        ],
      },
    ],
  },
});
