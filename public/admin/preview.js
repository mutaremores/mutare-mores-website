/* Custom Decap CMS preview templates — makes the editor's preview pane show
   a genuinely accurate rendering of how each entry looks on the live site,
   not an approximation. Loaded after decap-cms.js in public/admin/index.html,
   so the `CMS`, `createClass`, and `h` globals it exposes are already
   available (markdown-it, loaded via CDN in the same file, is used here too).

   How the accuracy works: each preview renders inside an isolated <iframe>
   whose document links the site's own extracted stylesheet
   (shared-site-styles.css — the exact same file public/index.html uses,
   see its own comment for why it was extracted) and wraps the real markup
   in the same room/element structure the live site uses (e.g. #roomLearn >
   .room-body > .learn-col), so the *real* CSS selectors apply to the *real*
   markup — no hand-copied values that can silently drift out of sync.
   Markdown fields (tldr/body/resources/etc.) are rendered through the same
   markdown-it library and options (`{html:true, linkify:true}`) that
   scripts/build-articles-json.mjs uses server-side, so the HTML is
   identical, not just similar.

   The iframe is intentionally isolated (rather than linking the site's CSS
   into the admin page directly) because that stylesheet contains
   unscoped rules like `body{overflow:hidden}` meant for the site's own
   full-page layout, which would break the admin UI if applied globally. */
(function () {
  if (typeof CMS === 'undefined' || typeof createClass === 'undefined' || typeof h === 'undefined') {
    return;
  }

  var md = (typeof window.markdownit === 'function')
    ? window.markdownit({ html: true, linkify: true })
    : null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderMarkdown(src) {
    if (!src) return '';
    return md ? md.render(src) : '<p>' + escapeHtml(src) + '</p>';
  }

  function statusBadgeClass(status) {
    if (status === 'Done') return 'badge-done';
    if (status === 'In progress') return 'badge-progress';
    return 'badge-notstarted';
  }

  // Entry "data" is an Immutable-ish structure; nested list fields come back
  // as something with a .toJS() method. This normalizes either shape (or a
  // missing value) into a plain JS array/object.
  function toPlain(value, fallback) {
    if (value == null) return fallback;
    if (typeof value.toJS === 'function') return value.toJS();
    return value;
  }

  function safeRender(renderFn) {
    try {
      return renderFn();
    } catch (e) {
      return h('p', { style: { fontStyle: 'italic', color: '#8d8d8d', padding: '16px' } },
        'Preview unavailable for this entry (' + (e && e.message ? e.message : 'unknown error') + '). This does not affect the saved content — check the real deployed site to see the real page.'
      );
    }
  }

  // Mounts `props.html` into an isolated iframe, wrapped in
  // #<roomId> > .room-body — matching the live site's own scoping, so
  // shared-site-styles.css's real (often #roomX-scoped) rules apply
  // exactly as they do on the live site.
  function makeFramePreview(roomId) {
    return createClass({
      writeFrame: function () {
        var node = this._frameNode;
        if (!node) return;
        var doc = node.contentDocument;
        if (!doc) return;
        if (!this._ready) {
          var stylesheetUrl = window.location.origin + '/shared-site-styles.css';
          doc.open();
          doc.write(
            '<!doctype html><html><head><meta charset="utf-8">' +
            '<link rel="preconnect" href="https://fonts.googleapis.com">' +
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
            '<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800;900&family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">' +
            '<link rel="stylesheet" href="' + stylesheetUrl + '">' +
            // The site's stylesheet assumes it owns the whole page (fixed
            // height, hidden overflow, for its own room-navigation system);
            // this preview just wants a normal scrolling block, so these
            // two rules are deliberately overridden for the iframe only.
            '<style>html,body{height:auto!important;overflow:visible!important;} body{margin:0;padding:28px;}</style>' +
            '</head><body><div id="' + roomId + '"><div class="room-body"><div id="frame-mount"></div></div></div></body></html>'
          );
          doc.close();
          this._ready = true;
        }
        var mount = doc.getElementById('frame-mount');
        if (mount) mount.innerHTML = this.props.html;
      },
      componentDidMount: function () { this.writeFrame(); },
      componentDidUpdate: function () { this.writeFrame(); },
      render: function () {
        var self = this;
        return h('iframe', {
          ref: function (node) { self._frameNode = node; },
          title: 'Live site preview',
          style: { width: '100%', minHeight: '640px', border: '1px solid #dcdcda', borderRadius: '4px', background: '#fff' }
        });
      },
    });
  }

  var ArticleFrame = makeFramePreview('roomLearn');
  var WelcomeFrame = makeFramePreview('roomLearn');
  var AboutFrame = makeFramePreview('roomAbout');
  var WorkFrame = makeFramePreview('roomWork');

  // Markup below is a deliberate byte-for-byte match of the real render
  // functions in public/index.html (articleColumnEl, welcomeColumnEl,
  // renderAboutRoom, renderWorkRoom) — kept in sync by hand since there's
  // no shared JS module between the site and the CMS admin, but the CSS
  // driving how it *looks* is no longer a separate copy (see above).

  var ArticlePreview = createClass({
    render: function () {
      var props = this.props;
      return safeRender(function () {
        var data = props.entry.get('data');
        var title = data.get('title') || 'Untitled';
        var category = data.get('category') || 'Uncategorized';
        var status = data.get('status') || 'Not started';
        var lastEdited = data.get('lastEdited') || '';
        var hasContent = data.get('hasContent');
        var tldr = data.get('tldr') || '';
        var body = data.get('body') || '';
        var resources = data.get('resources') || '';

        var bodyHtml = hasContent
          ? (
            '<div class="article-section-label">TL;DR</div>' + renderMarkdown(tldr) +
            '<div class="article-section-label">Notes</div>' + renderMarkdown(body) +
            renderMarkdown(resources)
          )
          : '<p class="article-body-text article-body-empty">This note hasn’t been written up yet — check back soon, or explore a related article below.</p>';

        var html =
          '<div class="learn-col">' +
          '<div class="kicker">Article</div>' +
          '<h3 class="article-title">' + escapeHtml(title) + '</h3>' +
          '<div class="article-meta-line">' +
          '<span class="status-badge ' + statusBadgeClass(status) + '">' + escapeHtml(status) + '</span>' +
          '<span class="status-badge badge-category">' + escapeHtml(category) + '</span>' +
          '</div>' +
          '<div class="article-meta-row2">' +
          '<button class="linked-articles-toggle" type="button">Linked articles <span class="caret-icon"></span></button>' +
          (lastEdited ? '<span class="article-date">Last edited ' + escapeHtml(lastEdited) + '</span>' : '') +
          '</div>' +
          '<div class="linked-articles-panel" hidden><div class="linked-articles-empty">No linked articles yet.</div></div>' +
          bodyHtml +
          '</div>';

        return h(ArticleFrame, { html: html });
      });
    },
  });

  var WelcomePreview = createClass({
    render: function () {
      var props = this.props;
      return safeRender(function () {
        var data = props.entry.get('data');
        var heading = data.get('heading') || '';
        var intro = data.get('intro') || '';
        var links = ['Articles by date', 'Articles by type', 'Creativity', 'Leadership', 'Organizational development', 'Systems thinking', 'Book list', 'All topics'];
        var html =
          '<div class="learn-col">' +
          '<div class="kicker">Welcome</div>' +
          '<h3>' + escapeHtml(heading) + '</h3>' +
          '<p>' + escapeHtml(intro) + '</p>' +
          '<ul class="learn-links">' +
          links.map(function (t) { return '<li><a>' + escapeHtml(t) + '</a></li>'; }).join('') +
          '</ul>' +
          '</div>';
        return h(WelcomeFrame, { html: html });
      });
    },
  });

  var AboutPreview = createClass({
    render: function () {
      var props = this.props;
      return safeRender(function () {
        var data = props.entry.get('data');
        var sections = toPlain(data.get('sections'), []);
        var html = sections.map(function (s) {
          return '<div class="room-section"><h2>' + escapeHtml(s.heading || '') + '</h2>' + renderMarkdown(s.body || '') + '</div>';
        }).join('');
        return h(AboutFrame, { html: html });
      });
    },
  });

  var WorkPreview = createClass({
    render: function () {
      var props = this.props;
      return safeRender(function () {
        var data = props.entry.get('data');
        var whatIDo = data.get('whatIDo') || '';
        var discoveryCall = data.get('discoveryCall') || '';
        var columns = toPlain(data.get('columns'), []);
        var workOnOutro = data.get('workOnOutro') || '';
        var faq = toPlain(data.get('faq'), []);

        var columnsHtml = columns.map(function (col) {
          var items = col.items || [];
          return '<div><h3>' + escapeHtml(col.title || '') + '</h3>' +
            items.map(function (it) {
              return '<details><summary>' + escapeHtml(it.summary || '') + '</summary>' + renderMarkdown(it.body || '') + '</details>';
            }).join('') +
            '</div>';
        }).join('');

        var faqHtml = faq.map(function (it) {
          return '<details><summary>' + escapeHtml(it.summary || '') + '</summary>' + renderMarkdown(it.body || '') + '</details>';
        }).join('');

        var html =
          '<div class="room-section"><h2>What I Do</h2>' + renderMarkdown(whatIDo) + '</div>' +
          '<div class="room-section"><h2>The Discovery Call</h2>' + renderMarkdown(discoveryCall) + '</div>' +
          '<div class="room-section"><h2>Things We Can Work On</h2><div class="work-columns">' + columnsHtml + '</div>' + renderMarkdown(workOnOutro) + '</div>' +
          '<div class="room-section"><h2>What It’s Like To Work With Me</h2>' + faqHtml + '</div>';

        return h(WorkFrame, { html: html });
      });
    },
  });

  CMS.registerPreviewTemplate('article', ArticlePreview);
  CMS.registerPreviewTemplate('learn_welcome', WelcomePreview);
  CMS.registerPreviewTemplate('about', AboutPreview);
  CMS.registerPreviewTemplate('work', WorkPreview);
})();
