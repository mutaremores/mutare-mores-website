# Mutare Mores Website

Prototype website for the Mutare Mores coaching business.

## What's here

This is currently a single self-contained static HTML file (`index.html`) — all HTML, CSS, and JavaScript live in one file, including the site's fonts and images (embedded as base64 data URIs). There's no build step; you can open `index.html` directly in a browser to preview it.

## Editing content

Right now, all page copy, article content, and links live directly inside `index.html`. There's no CMS or database behind it yet — to change text, add an article, or update a link, you edit the HTML/JS directly in this file (search for the `notionEntries` array for the Learn section's article list).

## Deploying

Because it's a single static file, this repo can be deployed as-is to any static hosting provider:

- **Netlify** or **Vercel** — connect this GitHub repo and it will auto-deploy on every push to `main`.
- **GitHub Pages** — enable Pages in the repo settings, pointing at the `main` branch root.

## Known placeholders

- The "Book a Discovery Call" button currently shows a JavaScript `alert()` instead of linking to a real booking tool (e.g. Calendly, Acuity).
- Article content in the Learn section is a static snapshot, not connected to a live source like Notion.

## Roadmap ideas

- Wire the Discovery Call button to a real booking integration.
- Move article content to a lightweight CMS (or a live Notion API connection) so it can be edited without touching code.
- Split the single HTML file into separate CSS/JS files as the site grows, if maintainability becomes an issue.
