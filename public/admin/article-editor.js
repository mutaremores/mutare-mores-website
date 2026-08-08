/* Custom Decap CMS widgets for the article collection (wired in
   config.yml), registered here so the editor form reads as the real
   article card instead of a generic stacked form:

   - BlockEditorControl: a Notion-style block editor (Editor.js) in place
     of the default markdown textarea, for the body/tldr/resources fields.
     Storage format is unchanged on purpose: content/articles/*.md still
     holds plain markdown, so scripts/build-articles-json.mjs and the live
     site need no changes. This widget just converts markdown -> Editor.js
     blocks on load, and blocks -> markdown on every change, entirely in
     the browser.
     Scope: headings (#/##/###), paragraphs with bold, italic, and
     [link](url) markdown, ordered/unordered/checklist lists (one level of
     nesting), and image/file blocks (ImageBlockTool/FileBlockTool below)
     -- matching what this site's actual content uses. Anything outside
     that (tables, code blocks, etc.) round-trips as a plain paragraph
     rather than being silently dropped, so nothing is ever lost, even if
     the block-editor representation of it is imperfect.

   - ArticleTitleControl / ArticleStatusControl / ArticleCategoryControl:
     render the title/status/category fields as the real site's own
     .article-title / .status-badge markup, directly editable in place
     (click the title to type, click a badge for a dropdown of the other
     options) -- the editor form IS the article preview now, so the
     collection's split preview pane is turned off in config.yml. */
(function () {
  if (typeof CMS === 'undefined' || typeof createClass === 'undefined' || typeof h === 'undefined') {
    return;
  }

  // ---- inline markdown <-> HTML (Editor.js block text is small HTML) ----
  function inlineMdToHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
  }

  function inlineHtmlToMd(html) {
    return String(html)
      .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '[$2]($1)')
      .replace(/<b>([^<]*)<\/b>|<strong>([^<]*)<\/strong>/g, function (_, a, b) { return '**' + (a || b) + '**'; })
      .replace(/<i>([^<]*)<\/i>|<em>([^<]*)<\/em>/g, function (_, a, b) { return '*' + (a || b) + '*'; })
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  }

  // ---- markdown -> Editor.js blocks ----
  function markdownToBlocks(markdown) {
    var lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    var blocks = [];
    var i = 0;

    function listItemMatch(line) {
      var m = line.match(/^(\s*)-\s\[( |x)\]\s+(.*)$/); // checklist
      if (m) return { indent: m[1].length, style: 'checklist', checked: m[2] === 'x', content: m[3] };
      m = line.match(/^(\s*)[-*]\s+(.*)$/); // unordered
      if (m) return { indent: m[1].length, style: 'unordered', content: m[2] };
      m = line.match(/^(\s*)\d+\.\s+(.*)$/); // ordered
      if (m) return { indent: m[1].length, style: 'ordered', content: m[2] };
      return null;
    }

    function makeItem(match) {
      var item = { content: inlineMdToHtml(match.content), meta: {}, items: [] };
      if (match.style === 'checklist') item.meta = { checked: match.checked };
      return item;
    }

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        blocks.push({ type: 'header', data: { text: inlineMdToHtml(heading[2]), level: heading[1].length } });
        i++;
        continue;
      }

      // Image/file blocks: a line that's *only* an image or a file link
      // (see blocksToMarkdown below for the exact markdown shape each
      // produces). Checked as whole-line matches, not inline replacements,
      // so a real image/file link mentioned inline within normal prose
      // still round-trips as plain inline markdown instead.
      var imageLine = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageLine) {
        blocks.push({ type: 'image', data: { alt: imageLine[1], url: imageLine[2] } });
        i++;
        continue;
      }
      var fileLine = line.match(/^\[📎\s*([^\]]*)\]\(([^)]+)\)$/);
      if (fileLine) {
        blocks.push({ type: 'file', data: { name: fileLine[1], url: fileLine[2] } });
        i++;
        continue;
      }

      var first = listItemMatch(line);
      if (first) {
        var style = first.style === 'checklist' ? 'checklist' : first.style;
        var topItems = [];
        var stack = [{ indent: -1, items: topItems }];
        while (i < lines.length) {
          var m = listItemMatch(lines[i]);
          if (!m) break;
          // A checklist/unordered/ordered run only mixes styles if the
          // source markdown does; once a run starts we just keep pulling
          // items regardless of exact style per line, matching this site's
          // actual content (no mixed-style lists in practice).
          var item = makeItem(m);
          while (stack.length && m.indent <= stack[stack.length - 1].indent) stack.pop();
          stack[stack.length - 1].items.push(item);
          stack.push({ indent: m.indent, items: item.items });
          i++;
        }
        blocks.push({ type: 'list', data: { style: style, items: topItems } });
        continue;
      }

      // Paragraph: collect until a blank line or a line that starts a new
      // block type.
      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !listItemMatch(lines[i]) && !lines[i].match(/^#{1,3}\s/)) {
        para.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', data: { text: inlineMdToHtml(para.join(' ')) } });
    }

    return { time: Date.now(), blocks: blocks, version: '2.30.0' };
  }

  // ---- Editor.js blocks -> markdown ----
  function listItemsToMarkdown(items, style, depth) {
    var indent = '  '.repeat(depth);
    return items.map(function (item, idx) {
      var prefix = style === 'ordered' ? (idx + 1) + '. '
        : style === 'checklist' ? '- [' + (item.meta && item.meta.checked ? 'x' : ' ') + '] '
        : '- ';
      var line = indent + prefix + inlineHtmlToMd(item.content || '');
      var children = (item.items && item.items.length)
        ? '\n' + listItemsToMarkdown(item.items, style, depth + 1)
        : '';
      return line + children;
    }).join('\n');
  }

  function blocksToMarkdown(data) {
    var blocks = (data && data.blocks) || [];
    return blocks.map(function (block) {
      if (block.type === 'header') {
        return '#'.repeat(block.data.level || 2) + ' ' + inlineHtmlToMd(block.data.text || '');
      }
      if (block.type === 'list') {
        return listItemsToMarkdown(block.data.items || [], block.data.style, 0);
      }
      if (block.type === 'paragraph') {
        return inlineHtmlToMd(block.data.text || '');
      }
      if (block.type === 'image') {
        return '![' + (block.data.alt || '') + '](' + (block.data.url || '') + ')';
      }
      if (block.type === 'file') {
        return '[📎 ' + (block.data.name || 'Download') + '](' + (block.data.url || '') + ')';
      }
      // Unknown block type: never silently drop content.
      return JSON.stringify(block.data || {});
    }).join('\n\n') + '\n';
  }

  // ---- Image / File block types ----
  // Editor.js's official Image tool needs an upload endpoint this static
  // site doesn't have. Instead: upload the file through the CMS's
  // existing Media Library tab (already works, GitHub-backed), then paste
  // the resulting URL here. Plain constructor-function + prototype
  // "class" (not ES6 `class`) to match this file's existing style and
  // Editor.js's own Tool contract (new ToolClass({data}), then
  // .render()/.save() on the instance) exactly -- no external dependency,
  // so no CDN version/global-name risk like the other Editor.js plugins.
  function ImageBlockTool(opts) {
    this.data = { url: (opts.data && opts.data.url) || '', alt: (opts.data && opts.data.alt) || '' };
  }
  ImageBlockTool.toolbox = {
    title: 'Image',
    icon: '<svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="12" height="12" rx="1" stroke="currentColor" fill="none" stroke-width="1.2"/><circle cx="4.5" cy="4.5" r="1.2" fill="currentColor"/><path d="M1.5 10L5 6.5L7.5 9L10 6L12.5 9.5" stroke="currentColor" fill="none" stroke-width="1.2"/></svg>',
  };
  ImageBlockTool.prototype.render = function () {
    var self = this;
    var wrapper = document.createElement('div');
    wrapper.className = 'ce-media-block';

    var urlInput = document.createElement('input');
    urlInput.className = 'ce-media-block-input';
    urlInput.placeholder = 'Paste image URL (upload it via the Media tab first)';
    urlInput.value = this.data.url;

    var altInput = document.createElement('input');
    altInput.className = 'ce-media-block-input';
    altInput.placeholder = 'Alt text (optional)';
    altInput.value = this.data.alt;

    var preview = document.createElement('img');
    preview.className = 'ce-media-block-preview';

    function refreshPreview() {
      if (self.data.url) {
        preview.src = self.data.url;
        preview.style.display = '';
      } else {
        preview.style.display = 'none';
      }
    }

    urlInput.addEventListener('input', function () {
      self.data.url = urlInput.value;
      refreshPreview();
    });
    altInput.addEventListener('input', function () {
      self.data.alt = altInput.value;
    });

    refreshPreview();
    wrapper.appendChild(urlInput);
    wrapper.appendChild(altInput);
    wrapper.appendChild(preview);
    return wrapper;
  };
  ImageBlockTool.prototype.save = function () {
    return { url: this.data.url, alt: this.data.alt };
  };

  function FileBlockTool(opts) {
    this.data = { url: (opts.data && opts.data.url) || '', name: (opts.data && opts.data.name) || '' };
  }
  FileBlockTool.toolbox = {
    title: 'File / PDF',
    icon: '<svg width="12" height="14" viewBox="0 0 12 14" xmlns="http://www.w3.org/2000/svg"><path d="M1 1H7L11 5V13H1V1Z" stroke="currentColor" fill="none" stroke-width="1.2"/><path d="M7 1V5H11" stroke="currentColor" fill="none" stroke-width="1.2"/></svg>',
  };
  FileBlockTool.prototype.render = function () {
    var self = this;
    var wrapper = document.createElement('div');
    wrapper.className = 'ce-media-block';

    var urlInput = document.createElement('input');
    urlInput.className = 'ce-media-block-input';
    urlInput.placeholder = 'Paste file URL (upload it via the Media tab first)';
    urlInput.value = this.data.url;

    var nameInput = document.createElement('input');
    nameInput.className = 'ce-media-block-input';
    nameInput.placeholder = 'Display name (e.g. Annual Report.pdf)';
    nameInput.value = this.data.name;

    urlInput.addEventListener('input', function () { self.data.url = urlInput.value; });
    nameInput.addEventListener('input', function () { self.data.name = nameInput.value; });

    wrapper.appendChild(urlInput);
    wrapper.appendChild(nameInput);
    return wrapper;
  };
  FileBlockTool.prototype.save = function () {
    return { url: this.data.url, name: this.data.name };
  };

  // ---- Decap widget: mounts an Editor.js instance, round-trips markdown ----
  var editorSeq = 0;

  var BlockEditorControl = createClass({
    // Runs once per instance, before that instance's first render() --
    // unlike doing this in componentDidMount, this can't race with a
    // sibling widget's mount when Decap renders multiple of these at once
    // (body/tldr/resources), which would otherwise let two instances
    // compute the same fallback DOM id.
    getInitialState: function () {
      this._domId = 'block-editor-' + (++editorSeq);
      return {};
    },
    componentDidMount: function () {
      var self = this;
      var initialMarkdown = this.props.value || '';

      // Editor.js reads its container by DOM id at construction time, so
      // this waits one tick for render() to have created the holder div.
      setTimeout(function () {
        self._editor = new window.EditorJS({
          holder: self._domId,
          minHeight: 80,
          data: markdownToBlocks(initialMarkdown),
          tools: {
            header: { class: window.Header, inlineToolbar: true, config: { levels: [2, 3], defaultLevel: 2 } },
            list: { class: window.EditorjsList, inlineToolbar: true },
            image: { class: ImageBlockTool },
            file: { class: FileBlockTool },
          },
          onChange: function () {
            self._editor.save().then(function (data) {
              self.props.onChange(blocksToMarkdown(data));
            });
          },
          onReady: function () {
            if (window.DragDrop) {
              try { new window.DragDrop(self._editor); } catch (e) { /* non-fatal */ }
            }
          },
        });
      }, 0);
    },
    componentWillUnmount: function () {
      if (this._editor && this._editor.destroy) {
        try { this._editor.destroy(); } catch (e) { /* already gone */ }
      }
    },
    // Decap re-renders controls on every keystroke elsewhere on the form;
    // Editor.js manages its own DOM once mounted, so this must never
    // re-render (that would destroy the live editing cursor/selection).
    shouldComponentUpdate: function () {
      return false;
    },
    render: function () {
      return h('div', { className: 'block-editor-wrap' },
        h('div', { id: this._domId })
      );
    },
  });

  CMS.registerWidget('block-editor', BlockEditorControl);

  // ---- Inline editing widgets: title/status/category rendered as the
  // real site markup (article-title / status-badge), directly editable in
  // place -- the editor form IS the article card, not a separate set of
  // form fields next to a read-only preview of one. ----

  function statusBadgeClass(status) {
    if (status === 'Done') return 'badge-done';
    if (status === 'In progress') return 'badge-progress';
    return 'badge-notstarted';
  }

  var ArticleTitleControl = createClass({
    componentDidMount: function () {
      var self = this;
      var node = this._node;
      node.textContent = this.props.value || '';
      node.addEventListener('input', function () {
        self.props.onChange(node.textContent);
      });
    },
    // Editing happens on a real DOM node this widget owns directly (not a
    // React-controlled contentEditable, which fights the browser for
    // cursor position on every keystroke); Decap re-rendering the form
    // elsewhere (status/category changes) must never touch this node's
    // subtree or the caret position/focus would be lost mid-edit.
    shouldComponentUpdate: function () {
      return false;
    },
    render: function () {
      var self = this;
      return h('h3', {
        id: this.props.forID,
        className: (this.props.classNameWrapper || '') + ' article-title',
        contentEditable: true,
        suppressContentEditableWarning: true,
        ref: function (node) { self._node = node; },
      });
    },
  });

  // Shared control for a single-select field rendered as a clickable pill
  // badge that opens a small dropdown of the other options on click.
  function makeBadgeSelectControl(extraClassName) {
    return createClass({
      getInitialState: function () {
        return { open: false };
      },
      componentDidMount: function () {
        var self = this;
        this._outsideHandler = function (e) {
          if (self._rootNode && !self._rootNode.contains(e.target)) {
            self.setState({ open: false });
          }
        };
        this._escHandler = function (e) {
          if (e.key === 'Escape') self.setState({ open: false });
        };
        document.addEventListener('mousedown', this._outsideHandler);
        document.addEventListener('keydown', this._escHandler);
      },
      componentWillUnmount: function () {
        document.removeEventListener('mousedown', this._outsideHandler);
        document.removeEventListener('keydown', this._escHandler);
      },
      toggle: function () {
        this.setState({ open: !this.state.open });
      },
      pick: function (value) {
        this.props.onChange(value);
        this.setState({ open: false });
      },
      render: function () {
        var self = this;
        var value = this.props.value || '';
        var options = toPlainArray(this.props.field.get('options'));
        var others = options.filter(function (o) { return o !== value; });
        var badgeClass = extraClassName === 'badge-category'
          ? 'badge-category'
          : statusBadgeClass(value);

        return h('div', {
          id: this.props.forID,
          className: (this.props.classNameWrapper || '') + ' badge-select-control',
          ref: function (node) { self._rootNode = node; },
        },
          h('span', {
            className: 'status-badge ' + badgeClass + ' badge-select-trigger',
            onClick: function () { self.toggle(); },
          }, value || '—'),
          this.state.open
            ? h('div', { className: 'badge-select-menu' },
              others.map(function (opt) {
                return h('div', {
                  key: opt,
                  className: 'badge-select-menu-item',
                  onClick: function () { self.pick(opt); },
                }, opt);
              })
            )
            : null
        );
      },
    });
  }

  function toPlainArray(value) {
    if (value == null) return [];
    if (typeof value.toJS === 'function') return value.toJS();
    return Array.isArray(value) ? value : [];
  }

  var ArticleStatusControl = makeBadgeSelectControl('status');
  var ArticleCategoryControl = makeBadgeSelectControl('badge-category');

  CMS.registerWidget('article-title', ArticleTitleControl);
  CMS.registerWidget('article-status', ArticleStatusControl);
  CMS.registerWidget('article-category', ArticleCategoryControl);

  // Last Edited and First Published aren't form fields at all (config.yml:
  // widget "hidden" on both) -- this is the only thing that ever sets
  // either. Last Edited is stamped with today's date on every save,
  // unconditionally. First Published is only filled in the first time
  // (i.e. only if it's still empty) and left alone after that, since
  // "first" stops meaning anything if it moved with every edit -- kept as
  // YYYY-MM-DD (not the short "Aug 5" style) to match every existing
  // article's stored format and what scripts/build-articles-json.mjs
  // already expects (d.firstPublished.slice(0,10)).
  // preSave is a global Decap event (not scoped per-collection in
  // config.yml), so this checks entry.get('collection') itself --
  // confirmed against Decap's own source that the entry passed to preSave
  // carries that key (the same pattern CMS.js itself uses internally,
  // e.g. publishUnpublishedEntry).
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  CMS.registerEventListener({
    name: 'preSave',
    handler: function (payload) {
      var entry = payload.entry;
      if (entry.get('collection') !== 'article') return entry.get('data');
      var today = new Date();
      var data = entry.get('data').set(
        'lastEdited',
        MONTH_NAMES[today.getMonth()] + ' ' + today.getDate()
      );
      if (!data.get('firstPublished')) {
        var iso = today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate());
        data = data.set('firstPublished', iso);
      }
      return data;
    },
  });
})();
