---
title: XSS test (temporary — delete before merge)
status: Done
category: Thoughts
sources: []
topics: []
firstPublished: '2026-08-13'
lastEdited: '2026-08-13'
tldr: |
  test
resources: |
  test
---
<script>window.__xssFired = true;</script>
<img src=x onerror="window.__xssFired = true">

Normal paragraph text.
