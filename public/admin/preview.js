/* Custom Decap CMS preview templates — makes the editor's preview pane
   mirror how each entry actually looks on the live site (public/index.html),
   instead of Decap's generic default preview. Loaded after decap-cms.js in
   public/admin/index.html, so the `CMS`, `createClass`, and `h` globals it
   exposes are already available.

   This is a lightweight approximation, not a pixel copy: markdown fields
   use widgetFor()/widgetsFor() so their rendering matches Decap's own
   markdown preview exactly, but the site's custom fonts aren't loaded here
   (see preview.css) and deeply-nested list fields (Work's per-column
   accordion items) are shown as plain text rather than full markdown, to
   keep this file simple. Good enough to check headings, order, badges, and
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

  var ArticlePreview = createClass({
    render: function () {
      var entry = this.props.entry;
      var data = entry.get('data');
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
              this.props.widgetFor('tldr'),
              h('div', { className: 'article-section-label' }, 'Notes'),
              this.props.widgetFor('body'),
              this.props.widgetFor('resources')
            )
          : h('p', { className: 'article-body-text article-body-empty' },
              "This note hasn't been written up yet — check back soon, or explore a related article below."
            )
      );
    },
  });

  var WelcomePreview = createClass({
    render: function () {
      var data = this.props.entry.get('data');
      return h('div', { className: 'mm-preview' },
        h('div', { className: 'kicker' }, 'Welcome'),
        h('h3', {}, data.get('heading')),
        h('p', {}, data.get('intro'))
      );
    },
  });

  var AboutPreview = createClass({
    render: function () {
      var sections = this.props.widgetsFor('sections') || [];
      return h('div', { className: 'mm-preview' },
        sections.map(function (item, i) {
          return h('div', { className: 'room-section', key: i },
            h('h2', {}, item.data.get('heading')),
            item.widgets.body
          );
        })
      );
    },
  });

  var WorkPreview = createClass({
    render: function () {
      var props = this.props;
      var columns = props.widgetsFor('columns') || [];
      var faq = props.widgetsFor('faq') || [];
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
              var items = col.data.get('items');
              return h('div', { key: i },
                h('h3', {}, col.data.get('title')),
                items
                  ? items.map(function (it, j) {
                      return h('details', { key: j },
                        h('summary', {}, it.get('summary')),
                        h('p', {}, it.get('body'))
                      );
                    })
                  : null
              );
            })
          ),
          props.widgetFor('workOnOutro')
        ),
        h('div', { className: 'room-section' },
          h('h2', {}, 'What It’s Like To Work With Me'),
          faq.map(function (item, i) {
            return h('details', { key: i },
              h('summary', {}, item.data.get('summary')),
              item.widgets.body
            );
          })
        )
      );
    },
  });

  CMS.registerPreviewTemplate('article', ArticlePreview);
  CMS.registerPreviewTemplate('learn_welcome', WelcomePreview);
  CMS.registerPreviewTemplate('about', AboutPreview);
  CMS.registerPreviewTemplate('work', WorkPreview);
})();
