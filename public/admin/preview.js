/* Custom Decap CMS preview templates — makes the editor's preview pane
   mirror how each entry actually looks on the live site (public/index.html),
   instead of Decap's generic default preview. Loaded after decap-cms.js in
   public/admin/index.html, so the `CMS`, `createClass`, and `h` globals it
   exposes are already available.

   This is a lightweight approximation, not a pixel copy: top-level markdown
   fields use widgetFor() so their rendering matches Decap's own markdown
   preview exactly, but the site's custom fonts aren't loaded here (see
   preview.css). Nested list-field items (About's sections, Work's per-column
   accordion items and FAQ) are read directly from the entry's raw data
   instead of via widgetsFor()/widgetFor()-on-list-items — on this Decap CMS
   version widgetsFor() throws for nested list items, so those bodies are
   shown as plain text rather than fully rendered markdown, to keep this
   preview from crashing. Good enough to check headings, order, badges, and
   overall shape before publishing — not a substitute for checking the
   Netlify deploy preview for anything that needs to be pixel-exact. */
(function () {
     if (typeof CMS === 'undefined' || typeof createClass === 'undefined' || typeof h === 'undefined') {
            return;
     }

   CMS.registerPreviewStyle('preview.css');

   function statusBadgeClass(status) {
          if (status === 'Done') return 'badge-done';
          if (status === 'In progress') return 'badge-progress';
          return 'badge-notstarted';
   }

   // Entry "data" is an Immutable-ish structure; nested list fields come back
   // as something with a .toJS() method. This normalizes either shape (or a
   // missing value) into a plain JS array/object so nested rendering never
   // has to guess whether it's holding an Immutable collection or not.
   function toPlain(value, fallback) {
          if (value == null) return fallback;
          if (typeof value.toJS === 'function') return value.toJS();
          return value;
   }

   function safeRender(renderFn) {
          try {
                   return renderFn();
          } catch (e) {
                   return h('div', { className: 'mm-preview' },
                                    h('p', { className: 'article-body-text article-body-empty' },
                                                'Preview unavailable for this entry (' + (e && e.message ? e.message : 'unknown error') + '). This does not affect the saved content — check the Netlify deploy preview to see the real page.'
                                              )
                                  );
          }
   }

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
                              return h('div', { className: 'mm-preview' },
                                                 h('div', { className: 'kicker' }, 'Article'),
                                                 h('h3', { className: 'article-title' }, title),
                                                 h('div', { className: 'article-meta-line' },
                                                               h('span', { className: 'status-badge ' + statusBadgeClass(status) }, status),
                                                               h('span', { className: 'status-badge badge-category' }, category)
                                                             ),
                                                 h('div', { className: 'article-meta-row2' },
                                                               h('span', {}, 'Linked articles'),
                                                               lastEdited ? h('span', { className: 'article-date' }, 'Last edited ' + lastEdited) : null
                                                             ),
                                                 hasContent
                                                   ? h('div', {},
                                                                       h('div', { className: 'article-section-label' }, 'TL;DR'),
                                                                       props.widgetFor('tldr'),
                                                                       h('div', { className: 'article-section-label' }, 'Notes'),
                                                                       props.widgetFor('body'),
                                                                       props.widgetFor('resources')
                                                                     )
                                                   : h('p', { className: 'article-body-text article-body-empty' },
                                                                       "This note hasn't been written up yet — check back soon, or explore a related article below."
                                                                     )
                                               );
                   });
          },
   });

   var WelcomePreview = createClass({
          render: function () {
                   var props = this.props;
                   return safeRender(function () {
                              var data = props.entry.get('data');
                              return h('div', { className: 'mm-preview' },
                                                 h('div', { className: 'kicker' }, 'Welcome'),
                                                 h('h3', {}, data.get('heading')),
                                                 h('p', {}, data.get('intro'))
                                               );
                   });
          },
   });

   var AboutPreview = createClass({
          render: function () {
                   var props = this.props;
                   return safeRender(function () {
                              var data = props.entry.get('data');
                              var sections = toPlain(data.get('sections'), []);
                              return h('div', { className: 'mm-preview' },
                                                 sections.map(function (s, i) {
                                                                return h('div', { className: 'room-section', key: i },
                                                                                       h('h2', {}, s.heading),
                                                                                       h('p', { className: 'article-body-text' }, s.body)
                                                                                     );
                                                 })
                                               );
                   });
          },
   });

   var WorkPreview = createClass({
          render: function () {
                   var props = this.props;
                   return safeRender(function () {
                              var data = props.entry.get('data');
                              var columns = toPlain(data.get('columns'), []);
                              var faq = toPlain(data.get('faq'), []);
                              return h('div', { className: 'mm-preview' },
                                                 h('div', { className: 'room-section' },
                                                               h('h2', {}, 'What I Do'),
                                                               props.widgetFor('whatIDo')
                                                             ),
                                                 h('div', { className: 'room-section' },
                                                               h('h2', {}, 'The Discovery Call'),
                                                               props.widgetFor('discoveryCall')
                                                             ),
                                                 h('div', { className: 'room-section' },
                                                               h('h2', {}, 'Things We Can Work On'),
                                                               h('div', { className: 'work-columns' },
                                                                               columns.map(function (col, i) {
                                                                                                  var items = col.items || [];
                                                                                                  return h('div', { key: i },
                                                                                                                             h('h3', {}, col.title),
                                                                                                                             items.map(function (it, j) {
                                                                                                                                                    return h('details', { key: j },
                                                                                                                                                                                   h('summary', {}, it.summary),
                                                                                                                                                                                   h('p', { className: 'article-body-text' }, it.body)
                                                                                                                                                                                 );
                                                                                                                                })
                                                                                                                           );
                                                                               })
                                                                             ),
                                                               props.widgetFor('workOnOutro')
                                                             ),
                                                 h('div', { className: 'room-section' },
                                                               h('h2', {}, 'What It’s Like To Work With Me'),
                                                               faq.map(function (item, i) {
                                                                                return h('details', { key: i },
                                                                                                         h('summary', {}, item.summary),
                                                                                                         h('p', { className: 'article-body-text' }, item.body)
                                                                                                       );
                                                               })
                                                             )
                                               );
                   });
          },
   });

   CMS.registerPreviewTemplate('article', ArticlePreview);
     CMS.registerPreviewTemplate('learn_welcome', WelcomePreview);
     CMS.registerPreviewTemplate('about', AboutPreview);
     CMS.registerPreviewTemplate('work', WorkPreview);
})();
