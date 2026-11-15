/* ════════════════════════════════════════════════════════════════
   SPL Library — dashboard application
   Cloud-compatible: all logic in appserver/static, KV Store backed,
   no custom REST handlers, no external resources.
   ════════════════════════════════════════════════════════════════ */

require([
  'jquery',
  'splunkjs/mvc',
  'splunkjs/mvc/simplexml/ready!'
], function ($, mvc) {
  'use strict';

  /* ── Config ───────────────────────────────────────────────── */
  var APP = 'spl_library';
  var COLLECTION = 'spl_library_queries';
  var FAV_COLLECTION = 'spl_library_favorites';   // one doc per user: { _key: username, keys: [...] }
  var USAGE_COLLECTION = 'spl_library_usage';     // one doc per query: { _key: query key, count }
  var STARRED = 'Starred';
  var SORTS = { newest: 'Newest', title: 'Title (A–Z)', used: 'Most used' };

  var CAT_COLLECTION = 'spl_library_categories'; // { _key, name, color, order }
  var OTHER = 'Other';                 // fallback category: cannot be renamed or deleted
  var RESERVED_NAMES = ['all', 'starred'];
  var PALETTE = {
    blue:   { dark: { bg: '#1a2740', accent: '#4f8ef7' }, light: { bg: '#e6eefd', accent: '#2563eb' } },
    green:  { dark: { bg: '#1a2c28', accent: '#3ecf8e' }, light: { bg: '#e1f7ec', accent: '#059669' } },
    purple: { dark: { bg: '#2a1f38', accent: '#b085f5' }, light: { bg: '#f2e9fb', accent: '#7c3aed' } },
    amber:  { dark: { bg: '#2a2010', accent: '#f5a623' }, light: { bg: '#fdf1de', accent: '#d97706' } },
    teal:   { dark: { bg: '#102a2a', accent: '#2dd4bf' }, light: { bg: '#dff6f4', accent: '#0d9488' } },
    pink:   { dark: { bg: '#331a2a', accent: '#f472b6' }, light: { bg: '#fce7f3', accent: '#db2777' } },
    red:    { dark: { bg: '#331a1d', accent: '#f87171' }, light: { bg: '#fee2e2', accent: '#dc2626' } },
    indigo: { dark: { bg: '#1e1f3a', accent: '#818cf8' }, light: { bg: '#e0e7ff', accent: '#4f46e5' } },
    slate:  { dark: { bg: '#1e2030', accent: '#8899aa' }, light: { bg: '#e9ecf2', accent: '#475569' } }
  };
  // Fixed keys make first-run seeding idempotent if two admins load the app at once
  var DEFAULT_CATEGORIES = [
    ['security', 'Security', 'blue'], ['network', 'Network', 'green'],
    ['application', 'Application', 'purple'], ['database', 'Database', 'amber'],
    ['performance', 'Performance', 'teal'], ['other', OTHER, 'slate']
  ].map(function (c, i) { return { _key: c[0], name: c[1], color: c[2], order: i }; });

  function categoryNames() { return state.categories.map(function (c) { return c.name; }); }
  function findCategory(name) {
    for (var i = 0; i < state.categories.length; i++) if (state.categories[i].name === name) return state.categories[i];
    return null;
  }
  function catStyle(name) {
    var c = findCategory(name);
    var swatch = PALETTE[c && c.color] || PALETTE.slate;
    return swatch[state.theme] || swatch.dark;
  }

  /* ── Theme ────────────────────────────────────────────────── */
  var THEME_KEY = 'spl_library_theme';
  function loadTheme() {
    try {
      var t = window.localStorage.getItem(THEME_KEY);
      return t === 'light' ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }
  function saveTheme(t) {
    try { window.localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }

  // Per-browser display preferences; not shared or put in links
  var WRAP_KEY = 'spl_library_wrap';
  var VIEW_KEY = 'spl_library_view';
  function loadPref(key, fallback) {
    try { return window.localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function savePref(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) {}
  }

  /* ── Splunk plumbing ──────────────────────────────────────── */
  function localePrefix() {
    // e.g. /en-US/app/spl_library/library  ->  /en-US
    var parts = window.location.pathname.split('/');
    return parts.length > 1 && parts[1] ? '/' + parts[1] : '/en-US';
  }
  var KV_ROOT = localePrefix() + '/splunkd/__raw/servicesNS/nobody/' + APP +
                '/storage/collections/data/';

  function csrfToken() {
    var m = document.cookie.match(/splunkweb_csrf_token_[^=]*=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function kv(method, path, body, collection) {
    return $.ajax({
      url: KV_ROOT + (collection || COLLECTION) + (path || '') + '?output_mode=json',
      type: method,
      contentType: 'application/json',
      data: body ? JSON.stringify(body) : undefined,
      headers: { 'X-Splunk-Form-Key': csrfToken(), 'X-Requested-With': 'XMLHttpRequest' }
    });
  }

  function currentUser() {
    try { return (window.$C && window.$C.USERNAME) || 'unknown'; }
    catch (e) { return 'unknown'; }
  }

  function searchUrl(spl) {
    return localePrefix() + '/app/' + APP + '/search?q=' +
           encodeURIComponent(spl.indexOf('|') === 0 ? spl : 'search ' + spl);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  /* ── State ────────────────────────────────────────────────── */
  var state = {
    queries: [], categories: DEFAULT_CATEGORIES.slice(), canManageCats: false,
    search: '', filterCat: 'All', filterTag: '', sort: 'newest', view: loadPref(VIEW_KEY, 'cards'),
    retrying: null, loadFailed: false, catDraft: null, catError: null,
    favorites: [], usage: {}, wrap: loadPref(WRAP_KEY, 'on') !== 'off',
    modal: null, form: null, tagInput: '', formSnapshot: null, confirmDiscard: false,
    expanded: {}, linkKey: null, pendingOpen: null,
    loading: true, error: null, notice: null, formError: null,
    theme: loadTheme()
  };

  /* ── Shareable URL ────────────────────────────────────────── */
  // View state lives in the fragment (#q=..&cat=..&sort=..&open=..) because
  // Splunk uses query-string parameters for its own dashboard tokens.
  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    var cat = p.get('cat');
    state.filterCat = cat || 'All';   // checked against the loaded categories by normalizeFilters()
    state.search = p.get('q') || '';
    state.filterTag = p.get('tag') || '';
    state.sort = SORTS.hasOwnProperty(p.get('sort')) ? p.get('sort') : 'newest';
    state.pendingOpen = p.get('open') || null;
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.search) p.set('q', state.search);
    if (state.filterCat !== 'All') p.set('cat', state.filterCat);
    if (state.filterTag) p.set('tag', state.filterTag);
    if (state.sort !== 'newest') p.set('sort', state.sort);
    if (state.linkKey && state.expanded[state.linkKey]) p.set('open', state.linkKey);
    var hash = p.toString();
    var base = window.location.pathname + window.location.search;
    if (base + (hash ? '#' + hash : '') !== base + window.location.hash) {
      window.history.replaceState(window.history.state, '', base + (hash ? '#' + hash : ''));
    }
  }

  function linkTo(key) {
    var l = window.location;
    return l.origin + l.pathname + l.search + '#' + new URLSearchParams({ open: key }).toString();
  }

  // Expands the query named by an incoming link; returns its key, or null.
  function applyPendingOpen() {
    var key = state.pendingOpen;
    state.pendingOpen = null;
    if (!key) return null;
    if (!findQuery(key)) {
      state.notice = 'The linked query was not found. It may have been deleted.';
      return null;
    }
    if (!filtered().some(function (q) { return q._key === key; })) {
      state.filterCat = 'All';
      state.filterTag = '';
      state.search = '';
    }
    state.expanded[key] = true;
    state.linkKey = key;
    return key;
  }

  /* ── Data ops ─────────────────────────────────────────────── */
  function findQuery(key) {
    for (var i = 0; i < state.queries.length; i++) if (state.queries[i]._key === key) return state.queries[i];
    return null;
  }

  // Resolves with the response, or null on any error, so optional data never blocks loading.
  function soft(req) {
    var d = $.Deferred();
    req.done(function (data) { d.resolve(data); }).fail(function () { d.resolve(null); });
    return d.promise();
  }

  // Seconds between retries while Splunk's KV Store is still starting (about a minute in all)
  var RETRY_DELAYS = [2, 3, 5, 8, 12, 15, 15];
  function retryable(xhr) { return xhr.status === 0 || xhr.status >= 500; }

  function collectionConfig(name) {
    return $.ajax({
      url: localePrefix() + '/splunkd/__raw/servicesNS/nobody/' + APP +
           '/storage/collections/config/' + name + '?output_mode=json',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
  }

  function loadAll(attempt) {
    attempt = attempt || 0;
    var extras = $.when(
      soft(kv('GET', '/' + encodeURIComponent(currentUser()), null, FAV_COLLECTION)),
      soft(kv('GET', '', null, USAGE_COLLECTION)),
      soft(kv('GET', '', null, CAT_COLLECTION)),
      soft(collectionConfig(CAT_COLLECTION))
    );
    kv('GET').done(function (data) {
      state.queries = Array.isArray(data) ? data : [];
      if (state.queries.length === 0) { seed(); return; }
      extras.done(function (fav, usage, cats, catConfig) {
        state.favorites = fav && Array.isArray(fav.keys) ? fav.keys : [];
        state.usage = {};
        (Array.isArray(usage) ? usage : []).forEach(function (u) {
          state.usage[u._key] = Number(u.count) || 0;
        });
        var entry = catConfig && catConfig.entry && catConfig.entry[0];
        state.canManageCats = !!(entry && entry.acl && entry.acl.can_write);
        applyCategories(cats);
        state.loading = false; state.retrying = null; state.loadFailed = false; state.error = null;
        normalizeFilters();
        var opened = applyPendingOpen();
        render();
        if (opened) revealCard(opened);
      });
    }).fail(function (xhr) {
      if (retryable(xhr) && attempt < RETRY_DELAYS.length) {
        state.retrying = { attempt: attempt + 1, of: RETRY_DELAYS.length };
        render();
        setTimeout(function () { loadAll(attempt + 1); }, RETRY_DELAYS[attempt] * 1000);
        return;
      }
      state.loading = false; state.retrying = null; state.loadFailed = true;
      state.error = 'Could not load library (HTTP ' + xhr.status + '). ' +
        'Check that the KV Store collection exists and you have read access.';
      render();
    });
  }

  function retryLoad() {
    state.error = null; state.loadFailed = false; state.loading = true;
    render();
    loadAll();
  }

  // Uses the stored categories, or seeds the defaults when the collection is empty.
  // When it could not be read at all (cats is null), the defaults are used without saving.
  function applyCategories(cats) {
    if (Array.isArray(cats) && cats.length) {
      state.categories = cats.map(function (c) {
        return { _key: c._key, name: String(c.name || ''), color: PALETTE[c.color] ? c.color : 'slate',
                 order: Number(c.order) || 0 };
      }).filter(function (c) { return c.name; }).sort(function (a, b) { return a.order - b.order; });
    } else {
      state.categories = DEFAULT_CATEGORIES.map(function (c) { return $.extend({}, c); });
      if (Array.isArray(cats) && state.canManageCats) {
        kv('POST', '/batch_save', state.categories, CAT_COLLECTION);
      }
    }
    if (!findCategory(OTHER)) {
      state.categories.push({ _key: 'other', name: OTHER, color: 'slate', order: state.categories.length });
    }
  }

  function normalizeFilters() {
    if (state.filterCat !== 'All' && state.filterCat !== STARRED && !findCategory(state.filterCat)) {
      state.filterCat = 'All';
    }
  }

  function seed() {
    var seeds = [
      { title: 'Failed Login Attempts (Last 24h)',
        description: 'Detects accounts with more than 5 failed logins — useful for brute-force detection.',
        spl: 'index=security sourcetype=WinEventLog EventCode=4625\n| stats count by Account_Name, src_ip\n| where count > 5\n| sort -count',
        category: 'Security', tags: 'security,authentication,windows' },
      { title: 'Top Bandwidth Consumers',
        description: 'Shows hosts consuming the most network bandwidth.',
        spl: 'index=network sourcetype=netflow\n| stats sum(bytes) as total_bytes by src_ip\n| sort -total_bytes\n| head 20\n| eval total_MB = round(total_bytes/1024/1024, 2)',
        category: 'Network', tags: 'network,bandwidth,performance' },
      { title: 'Error Rate by Service (Last Hour)',
        description: 'Percentage of ERROR-level events per service in the past hour.',
        spl: 'index=app_logs level=ERROR earliest=-1h\n| stats count as errors by service\n| appendcols [search index=app_logs earliest=-1h | stats count as total by service]\n| eval error_rate = round((errors/total)*100, 2)\n| sort -error_rate',
        category: 'Application', tags: 'errors,monitoring,application' },
      { title: 'DNS Lookup Failures',
        description: 'NXDOMAIN responses that may indicate C2 beacon activity or misconfigured hosts.',
        spl: 'index=dns sourcetype=dns_logs rcode=NXDOMAIN\n| stats count by src_ip, query\n| sort -count\n| head 50',
        category: 'Security', tags: 'dns,security,threat-hunting' },
      { title: 'DB Connect Job Duration & Errors',
        description: 'Extracts execution duration, status, and any localized error message from ' +
          'DB Connect (dbx_server) job_manager executions in _internal, useful for monitoring ' +
          'input job health and diagnosing failures.',
        spl: "index=_internal host=\"*\" sourcetype=dbx_server feature=input component=job_manager action=execute\n| rex field=_raw \"\\\"duration\\\":(?<duration>\\d+).*?\\\"status\\\":\\\"(?<status>[^\\\"]+)\\\"\"\n| eval duration_seconds=round(duration/1000,3)\n| rex field=_raw \"localizedMessage\\\":\\\"(?<last_error>.*?)\\\"(?=\\})\"\n| eval last_error=replace(last_error, \"\\\\\\\\\\\"\", \"\\\"\")\n| stats count by status,duration_seconds,name,last_error",
        category: 'Database', tags: 'dbconnect,dbx,internal,job_manager,monitoring' },
      { title: 'Microsoft 365 Add-on: OpenTelemetry Metrics by Data Input',
        description: 'Tracks OpenTelemetry event metrics reported by the Splunk Add-on for ' +
          'Microsoft Office 365, showing the max metric value per data input, useful for ' +
          'monitoring add-on health and per-input throughput.',
        spl: "index=_internal sourcetype=\"splunk:ta:o365:log\"  \"OpenTelemetry Metric: splunk.addon.events\"\n| rex field=_raw \"message=\\\"(?<message_action>[^\\\":]+)\"\n| chart max(value) by datainput",
        category: 'Application', tags: 'microsoft365,o365,addon,opentelemetry,monitoring' }
    ];
    var batch = seeds.map(function (s) {
      s.created_at = today(); s.updated_at = today(); s.author = 'seed';
      return s;
    });
    kv('POST', '/batch_save', batch).always(function () {
      // batch_save may not exist on all versions; fall back to singles
      kv('GET').done(function (data) {
        if (Array.isArray(data) && data.length > 0) {
          state.queries = data; state.loading = false; render();
        } else {
          var done = 0;
          batch.forEach(function (s) {
            kv('POST', '', s).always(function () {
              done++;
              if (done === batch.length) loadAll();
            });
          });
        }
      });
    });
  }

  function createQuery(q) {
    q.created_at = today(); q.updated_at = today(); q.author = currentUser();
    kv('POST', '', q).done(function (res) {
      q._key = res._key;
      state.queries.unshift(q);
      closeModal();
    }).fail(function (xhr) {
      state.formError = saveError(xhr); render();
    });
  }

  function updateQuery(key, q) {
    q.updated_at = today();
    delete q._user; delete q._owner;
    kv('POST', '/' + encodeURIComponent(key), q).done(function () {
      for (var i = 0; i < state.queries.length; i++) {
        if (state.queries[i]._key === key) {
          state.queries[i] = $.extend({}, q, { _key: key });
          break;
        }
      }
      closeModal();
    }).fail(function (xhr) {
      state.formError = saveError(xhr); render();
    });
  }

  function deleteQuery(key) {
    if (!window.confirm('Remove this query from the library?')) return;
    kv('DELETE', '/' + encodeURIComponent(key)).done(function () {
      state.queries = state.queries.filter(function (q) { return q._key !== key; });
      delete state.expanded[key];
      if (state.linkKey === key) state.linkKey = null;
      if (state.usage[key]) {
        delete state.usage[key];
        kv('DELETE', '/' + encodeURIComponent(key), null, USAGE_COLLECTION);
      }
      if (state.favorites.indexOf(key) !== -1) {
        var prev = state.favorites.slice();
        state.favorites = state.favorites.filter(function (k) { return k !== key; });
        saveFavorites(prev);
      }
      render();
    }).fail(function (xhr) {
      state.error = 'Delete failed (HTTP ' + xhr.status + '). You may not have write access.';
      render();
    });
  }

  function isFavorite(key) { return state.favorites.indexOf(key) !== -1; }

  function toggleFavorite(key) {
    var prev = state.favorites.slice();
    if (isFavorite(key)) state.favorites = state.favorites.filter(function (k) { return k !== key; });
    else state.favorites = state.favorites.concat([key]);
    saveFavorites(prev);
    render();
    focusInCard(key, '.sl-star');
  }

  // batch_save upserts by _key, so it creates the user's doc on first use.
  function saveFavorites(prev) {
    var keys = state.favorites.filter(findQuery);
    kv('POST', '/batch_save', [{ _key: currentUser(), keys: keys }], FAV_COLLECTION)
      .fail(function (xhr) {
        state.favorites = prev;
        state.error = 'Could not save favorites (HTTP ' + xhr.status + ').';
        render();
      });
  }

  function recordUse(key) {
    var n = (state.usage[key] || 0) + 1;
    state.usage[key] = n;
    // The KV Store has no atomic increment; simultaneous clicks by two people
    // can drop a count, which is acceptable for a popularity ranking.
    kv('POST', '/batch_save', [{ _key: key, count: n, last_used: new Date().toISOString() }],
       USAGE_COLLECTION);
    var cards = document.querySelectorAll('#sl-main .sl-card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-key') === key) {
        var u = cards[i].querySelector('.sl-uses');
        if (u) u.textContent = usesText(n);
      }
    }
  }

  function usesText(n) { return n === 1 ? '1 use' : n + ' uses'; }

  function saveError(xhr) {
    if (xhr.status === 403) return 'Save failed: you do not have write permission on this collection.';
    return 'Save failed (HTTP ' + xhr.status + '). Please try again.';
  }

  /* ── Derived ──────────────────────────────────────────────── */
  function tagsOf(q) {
    if (!q.tags) return [];
    return String(q.tags).split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function filtered() {
    var s = state.search.toLowerCase();
    var newest = function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); };
    var byTitle = function (a, b) {
      return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
    };
    var order = {
      newest: newest,
      title: byTitle,
      used: function (a, b) { return (state.usage[b._key] || 0) - (state.usage[a._key] || 0) || newest(a, b); }
    }[state.sort] || newest;
    return state.queries.filter(function (q) {
      var catOk = state.filterCat === 'All' ||
        (state.filterCat === STARRED ? isFavorite(q._key) : q.category === state.filterCat);
      var tag = state.filterTag.toLowerCase();
      var tagOk = !tag || tagsOf(q).some(function (t) { return t.toLowerCase() === tag; });
      var hay = [q.title, q.description, q.spl, q.tags].join(' ').toLowerCase();
      return catOk && tagOk && (!s || hay.indexOf(s) !== -1);
    }).sort(order);
  }

  function counts() {
    var c = { All: state.queries.length };
    c[STARRED] = state.queries.filter(function (q) { return isFavorite(q._key); }).length;
    categoryNames().forEach(function (cat) {
      c[cat] = state.queries.filter(function (q) { return q.category === cat; }).length;
    });
    return c;
  }

  /* ── Render ───────────────────────────────────────────────── */
  var $root = $('#spl-library-root');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var SVG_OPEN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  var ICONS = {
    search:  SVG_OPEN + '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    sun:     SVG_OPEN + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4' +
             'M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon:    SVG_OPEN + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    chevron: SVG_OPEN + '<path d="M6 9l6 6 6-6"/></svg>',
    viewCards: SVG_OPEN + '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/></svg>',
    viewList: SVG_OPEN + '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    up:      SVG_OPEN + '<path d="M18 15l-6-6-6 6"/></svg>',
    trash:   SVG_OPEN + '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    star:    SVG_OPEN + '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>'
  };
  ICONS.starOn = ICONS.star.replace('fill="none"', 'fill="currentColor"');
  function icon(cls, name) {
    var s = el('span', cls);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name];
    return s;
  }

  function firstLine(text) {
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) if (lines[i].trim()) return lines[i].trim();
    return '';
  }

  // While searching, preview the line that contains the match instead of the first line.
  function previewLine(spl, needle) {
    if (needle) {
      var lines = String(spl || '').split('\n'), n = needle.toLowerCase();
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().indexOf(n) !== -1) return lines[i].trim();
      }
    }
    return firstLine(spl);
  }

  /* ── SPL syntax highlighting ──────────────────────────────── */
  var KW_ANYCASE = { by: 1, as: 1, over: 1, output: 1, outputnew: 1 };
  var KW_UPPER = { AND: 1, OR: 1, NOT: 1, XOR: 1 };
  var RE_WORD = /[A-Za-z_][\w.:]*/y;
  var RE_NUM = /\d+(?:\.\d+)?/y;
  var RE_FN = /\s*\(/y;
  var RE_CMP = /\s*(?:!=|<=|>=|==|=|<|>)/y;
  function sticky(re, text, at) { re.lastIndex = at; var m = re.exec(text); return m ? m[0] : null; }

  // Splits SPL into spans of {s, e, t}; t is a token class or null for plain text.
  // Commands follow a pipe or an opening bracket; fields precede a comparison.
  function tokenizeSpl(text) {
    var out = [], plain = 0, i = 0, n = text.length, expectCmd = false, w;
    function emit(s, e, t) {
      if (s > plain) out.push({ s: plain, e: s, t: null });
      out.push({ s: s, e: e, t: t });
      plain = e;
    }
    function afterWordChar(at) { return /[\w.]/.test(text.charAt(at - 1)); }
    while (i < n) {
      var ch = text.charAt(i);
      if (text.substr(i, 3) === '```') {
        var close = text.indexOf('```', i + 3);
        var end = close === -1 ? n : close + 3;
        emit(i, end, 'cm'); i = end; expectCmd = false;
      } else if (ch === '"' || ch === "'") {
        var j = i + 1;
        while (j < n && text.charAt(j) !== ch) j += text.charAt(j) === '\\' ? 2 : 1;
        j = Math.min(j + 1, n);
        emit(i, j, ch === '"' ? 'str' : 'fld'); i = j; expectCmd = false;
      } else if (ch === '|' || ch === '[' || ch === ']') {
        emit(i, i + 1, 'pipe'); i++; expectCmd = ch !== ']';
      } else if ((w = sticky(RE_WORD, text, i)) && !afterWordChar(i)) {
        var t = null, after = i + w.length;
        if (expectCmd) t = 'cmd';
        else if (sticky(RE_FN, text, after) !== null) t = 'fn';
        else if (sticky(RE_CMP, text, after) !== null) t = 'fld';
        else if (KW_ANYCASE[w.toLowerCase()] || KW_UPPER[w]) t = 'kw';
        if (t) emit(i, after, t);
        i = after; expectCmd = false;
      } else if ((w = sticky(RE_NUM, text, i)) && !afterWordChar(i)) {
        emit(i, i + w.length, 'num'); i += w.length; expectCmd = false;
      } else {
        if (!/\s/.test(ch)) expectCmd = false;
        i++;
      }
    }
    if (n > plain) out.push({ s: plain, e: n, t: null });
    return out;
  }

  function matchRanges(text, needle) {
    var out = [], hay = text.toLowerCase(), n = (needle || '').toLowerCase();
    // Lower-casing can change length for a few Unicode characters; skip highlighting then
    if (!n || hay.length !== text.length) return out;
    for (var i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) out.push([i, i + n.length]);
    return out;
  }

  // Appends text to parent as token spans, wrapping search matches in <mark>.
  // Builds DOM nodes from textContent only, so query text can never inject HTML.
  function appendRich(parent, text, tokens, needle) {
    var ranges = matchRanges(text, needle), r = 0;
    tokens.forEach(function (tk) {
      var pos = tk.s;
      while (pos < tk.e) {
        while (r < ranges.length && ranges[r][1] <= pos) r++;
        var hit = r < ranges.length && ranges[r][0] <= pos;
        var stop = Math.min(tk.e, hit ? ranges[r][1] : (r < ranges.length ? ranges[r][0] : tk.e));
        var piece = text.slice(pos, stop);
        var node = tk.t ? el('span', 'sl-tk-' + tk.t, piece) : document.createTextNode(piece);
        if (hit) { var mark = el('mark', 'sl-hit'); mark.appendChild(node); node = mark; }
        parent.appendChild(node);
        pos = stop;
      }
    });
    return parent;
  }

  function highlighted(tag, cls, text, needle) {
    text = String(text || '');
    return appendRich(el(tag, cls), text, [{ s: 0, e: text.length, t: null }], needle);
  }

  function splBlock(tag, cls, spl, needle) {
    spl = String(spl || '');
    return appendRich(el(tag, cls), spl, tokenizeSpl(spl), needle);
  }

  function copyText(text) {
    function legacyCopy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(legacyCopy);
    } else {
      legacyCopy();
    }
  }

  function confirmButton(btn, label) {
    var original = btn.textContent;
    btn.textContent = '✓ ' + label;
    btn.classList.add('copied');
    setTimeout(function () { btn.textContent = original; btn.classList.remove('copied'); }, 1800);
  }

  function cardEl(key) {
    var cards = document.querySelectorAll('#sl-main .sl-card');
    for (var i = 0; i < cards.length; i++) if (cards[i].getAttribute('data-key') === key) return cards[i];
    return null;
  }

  function focusInCard(key, selector) {
    var c = cardEl(key), f = c && c.querySelector(selector);
    if (f) f.focus();
  }

  function revealCard(key) {
    var c = cardEl(key);
    if (!c) return;
    c.scrollIntoView({ block: 'center' });
    c.classList.add('sl-flash');
    setTimeout(function () { c.classList.remove('sl-flash'); }, 1800);
  }

  function focusSearch() {
    var s = $root[0].querySelector('.sl-search-input');
    if (s) { s.focus(); s.select(); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || state.modal || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    e.preventDefault();
    focusSearch();
  });

  function render() {
    $root.empty();
    var root = $root[0];
    root.setAttribute('data-theme', state.theme);
    // Container-query wrapper; the modal overlay stays outside it because
    // containment would make it the containing block for position:fixed.
    var app = el('div', 'sl-app');
    root.appendChild(app);

    /* Top bar */
    var topbar = el('div', 'sl-topbar');
    var logo = el('div', 'sl-logo');
    logo.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">' +
      '<rect width="26" height="26" rx="6" fill="#1e3a5f"/>' +
      '<path d="M7 10l6-4 6 4-6 4z" fill="#4f8ef7"/>' +
      '<path d="M7 16l6 4 6-4-6-4z" fill="#7eb8f7" opacity=".7"/></svg>';
    logo.appendChild(el('span', 'sl-logo-text', 'SPL Library'));
    topbar.appendChild(logo);
    topbar.appendChild(el('div', 'sl-spacer'));

    var sw = el('div', 'sl-search-wrap' + (state.search ? ' has-value' : ''));
    sw.appendChild(icon('sl-search-icon', 'search'));
    var sInput = el('input', 'sl-search-input');
    sInput.type = 'text';
    sInput.placeholder = 'Search queries, tags, SPL…';
    sInput.setAttribute('aria-label', 'Search queries');
    sInput.value = state.search;
    function setSearch(v) {
      state.search = v;
      sw.classList.toggle('has-value', !!v);
      renderMainOnly();
    }
    sInput.addEventListener('input', function () { setSearch(this.value); });
    sInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && this.value) { e.preventDefault(); this.value = ''; setSearch(''); }
    });
    sw.appendChild(sInput);
    var kbd = el('span', 'sl-search-kbd', '/');
    kbd.title = 'Press / to search';
    sw.appendChild(kbd);
    var clearBtn = el('button', 'sl-search-clear', '×');
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.addEventListener('click', function () { sInput.value = ''; setSearch(''); sInput.focus(); });
    sw.appendChild(clearBtn);
    topbar.appendChild(sw);

    var themeBtn = el('button', 'sl-btn-theme');
    themeBtn.appendChild(icon(null, state.theme === 'light' ? 'moon' : 'sun'));
    themeBtn.type = 'button';
    themeBtn.title = state.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    themeBtn.setAttribute('aria-label', themeBtn.title);
    themeBtn.addEventListener('click', function () {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      saveTheme(state.theme);
      render();
    });
    topbar.appendChild(themeBtn);

    var addBtn = el('button', 'sl-btn-primary', '+ Add query');
    addBtn.disabled = state.loading;
    addBtn.addEventListener('click', function () { openModal(null); });
    topbar.appendChild(addBtn);
    app.appendChild(topbar);

    if (state.loading) {
      app.appendChild(skeleton());
      return;
    }

    /* Layout */
    var layout = el('div', 'sl-layout');

    /* Sidebar */
    var side = el('div', 'sl-sidebar');
    var heading = el('div', 'sl-side-heading-row');
    heading.appendChild(el('p', 'sl-side-heading', 'Category'));
    if (state.canManageCats) {
      var manage = el('button', 'sl-side-manage', 'Manage');
      manage.type = 'button';
      manage.title = 'Add, rename, recolor, reorder or delete categories';
      manage.addEventListener('click', openCategoryModal);
      heading.appendChild(manage);
    }
    side.appendChild(heading);
    var c = counts();
    ['All', STARRED].concat(categoryNames()).forEach(function (cat) {
      var active = state.filterCat === cat;
      var btn = el('button', 'sl-cat-btn' + (active ? ' active' : '') + (cat === STARRED ? ' sl-cat-starred' : ''));
      var s = cat !== 'All' && cat !== STARRED ? catStyle(cat) : null;
      if (active && s) btn.style.color = s.accent;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      var left = el('span', 'sl-cat-left');
      if (cat === STARRED) {
        left.appendChild(icon('sl-cat-star', 'starOn'));
      } else if (s) {
        var dot = el('span', 'sl-cat-dot');
        dot.style.background = s.accent;
        left.appendChild(dot);
      }
      left.appendChild(document.createTextNode(cat));
      btn.appendChild(left);
      btn.appendChild(el('span', 'sl-cat-count', String(c[cat] || 0)));
      btn.addEventListener('click', function () { state.filterCat = cat; render(); });
      side.appendChild(btn);
    });
    side.appendChild(el('hr', 'sl-side-divider'));
    var meta = el('p', 'sl-side-meta');
    meta.innerHTML = state.queries.length + ' saved ' +
      (state.queries.length === 1 ? 'query' : 'queries') +
      '<br><small>Stored in KV Store \u2014 shared across this Splunk instance.</small>';
    side.appendChild(meta);
    layout.appendChild(side);

    /* Main */
    var main = el('div', 'sl-main');
    main.id = 'sl-main';
    layout.appendChild(main);
    app.appendChild(layout);
    renderMain(main);

    if (state.modal === 'categories') root.appendChild(renderCategoryModal());
    else if (state.modal) root.appendChild(renderModal());
  }

  // Placeholder layout shown while the library loads, shaped like the real one
  function skeleton() {
    var layout = el('div', 'sl-layout sl-skeleton');
    layout.setAttribute('aria-busy', 'true');
    layout.setAttribute('aria-label', 'Loading queries');
    var side = el('div', 'sl-sidebar');
    for (var i = 0; i < 8; i++) side.appendChild(el('div', 'sl-sk sl-sk-line'));
    layout.appendChild(side);
    var main = el('div', 'sl-main');
    if (state.retrying) {
      main.appendChild(el('div', 'sl-notice sl-retry-notice',
        'Waiting for Splunk\u2019s KV Store to start\u2026 retrying (attempt ' +
        state.retrying.attempt + ' of ' + state.retrying.of + ')'));
    }
    for (var j = 0; j < 4; j++) {
      var card = el('div', 'sl-sk-card');
      card.appendChild(el('div', 'sl-sk sl-sk-title'));
      card.appendChild(el('div', 'sl-sk sl-sk-text'));
      card.appendChild(el('div', 'sl-sk sl-sk-text sl-sk-short'));
      card.appendChild(el('div', 'sl-sk sl-sk-code'));
      main.appendChild(card);
    }
    layout.appendChild(main);
    return layout;
  }

  function renderMainOnly() {
    var main = document.getElementById('sl-main');
    if (main) { main.innerHTML = ''; renderMain(main); }
  }

  function renderMain(main) {
    writeHash();
    main.classList.toggle('compact', state.view === 'compact');
    if (state.error) {
      var banner = el('div', 'sl-error-banner');
      banner.appendChild(el('span', null, state.error));
      if (state.loadFailed) {
        var again = el('button', 'sl-btn-retry', 'Try again');
        again.type = 'button';
        again.addEventListener('click', retryLoad);
        banner.appendChild(again);
      }
      main.appendChild(banner);
    }
    if (state.notice) {
      var notice = el('div', 'sl-notice');
      notice.appendChild(el('span', null, state.notice));
      var dismiss = el('button', 'sl-notice-close', '\u00d7');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', function () { state.notice = null; renderMainOnly(); });
      notice.appendChild(dismiss);
      main.appendChild(notice);
    }

    var rows = filtered();
    var toolbar = el('div', 'sl-toolbar');
    var filteredView = state.search || state.filterCat !== 'All' || state.filterTag;
    var noun = filteredView ? (rows.length === 1 ? 'result' : 'results')
                            : (rows.length === 1 ? 'query' : 'queries');
    var left = el('div', 'sl-toolbar-left');
    left.appendChild(el('p', 'sl-results-info',
      rows.length + ' ' + noun +
      (state.filterCat !== 'All' ? ' in ' + state.filterCat : '') +
      (state.search ? ' matching "' + state.search + '"' : '')));
    if (state.filterTag) {
      var chip = el('button', 'sl-tag-filter');
      chip.type = 'button';
      chip.title = 'Stop filtering by this tag';
      chip.appendChild(el('span', null, '#' + state.filterTag));
      chip.appendChild(el('span', 'sl-tag-filter-x', '\u00d7'));
      chip.setAttribute('aria-label', 'Remove tag filter ' + state.filterTag);
      chip.addEventListener('click', function () { state.filterTag = ''; renderMainOnly(); });
      left.appendChild(chip);
    }
    toolbar.appendChild(left);
    var right = el('div', 'sl-toolbar-right');
    var wrapLabel = el('label', 'sl-wrap-toggle');
    var wrapBox = el('input');
    wrapBox.type = 'checkbox';
    wrapBox.checked = state.wrap;
    wrapBox.addEventListener('change', function () {
      state.wrap = this.checked;
      savePref(WRAP_KEY, state.wrap ? 'on' : 'off');
      var blocks = document.querySelectorAll('#sl-main .sl-spl');
      for (var i = 0; i < blocks.length; i++) blocks[i].classList.toggle('wrap', state.wrap);
    });
    wrapLabel.appendChild(wrapBox);
    wrapLabel.appendChild(document.createTextNode('Wrap lines'));
    right.appendChild(wrapLabel);
    var views = el('div', 'sl-view-toggle');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'Layout');
    [['cards', 'Card view'], ['compact', 'Compact view']].forEach(function (v) {
      var b = el('button', 'sl-view-btn' + (state.view === v[0] ? ' active' : ''));
      b.type = 'button';
      b.title = v[1];
      b.setAttribute('aria-label', v[1]);
      b.setAttribute('aria-pressed', state.view === v[0] ? 'true' : 'false');
      b.setAttribute('data-view', v[0]);
      b.appendChild(icon(null, v[0] === 'cards' ? 'viewCards' : 'viewList'));
      b.addEventListener('click', function () {
        state.view = v[0];
        savePref(VIEW_KEY, state.view);
        renderMainOnly();
      });
      views.appendChild(b);
    });
    right.appendChild(views);
    var sortWrap = el('label', 'sl-sort');
    sortWrap.appendChild(document.createTextNode('Sort'));
    var sortSel = el('select', 'sl-sort-select');
    Object.keys(SORTS).forEach(function (k) {
      var o = el('option', null, SORTS[k]);
      o.value = k;
      if (state.sort === k) o.selected = true;
      sortSel.appendChild(o);
    });
    sortSel.addEventListener('change', function () { state.sort = this.value; renderMainOnly(); });
    sortWrap.appendChild(sortSel);
    right.appendChild(sortWrap);
    toolbar.appendChild(right);
    main.appendChild(toolbar);

    if (rows.length === 0 && !state.error) {
      var empty = el('div', 'sl-empty');
      empty.appendChild(el('div', 'sl-empty-icon', state.filterCat === STARRED && !state.search ? '\u2606' : '\u25fb'));
      if (state.filterCat === STARRED && !state.search) {
        empty.appendChild(el('p', null, 'No starred queries yet.'));
        empty.appendChild(el('p', 'sl-empty-hint', 'Use the star on any query to keep it here.'));
        main.appendChild(empty);
        return;
      }
      empty.appendChild(el('p', null, 'No queries match.'));
      var link = el('a', null, 'Add a new query');
      link.addEventListener('click', function () { openModal(null); });
      empty.appendChild(link);
      main.appendChild(empty);
      return;
    }

    rows.forEach(function (q) { main.appendChild(card(q)); });
  }

  function card(q) {
    var s = catStyle(q.category);
    var open = !!state.expanded[q._key];

    var c = el('div', 'sl-card' + (open ? ' open' : ''));
    c.setAttribute('data-key', q._key || '');
    c.style.borderLeft = '3px solid ' + s.accent;
    if (open) c.style.boxShadow = '0 4px 24px ' + s.accent + '18';

    var hdr = el('div', 'sl-card-header');
    if (state.view === 'compact' && q.description) hdr.title = q.description;
    hdr.tabIndex = 0;
    hdr.setAttribute('role', 'button');
    hdr.setAttribute('aria-expanded', open ? 'true' : 'false');
    function toggle(refocus) {
      state.expanded[q._key] = !state.expanded[q._key];
      if (state.expanded[q._key]) state.linkKey = q._key;
      else if (state.linkKey === q._key) state.linkKey = null;
      renderMainOnly();
      if (refocus) focusInCard(q._key, '.sl-card-header');
    }
    hdr.addEventListener('click', function () { toggle(false); });
    hdr.addEventListener('keydown', function (e) {
      if (e.target !== hdr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(true); }
    });

    var content = el('div', 'sl-card-content');
    var titleRow = el('div', 'sl-title-row');
    titleRow.appendChild(highlighted('span', 'sl-card-title', q.title || '(untitled)', state.search));
    var badge = el('span', 'sl-badge');
    badge.style.background = s.bg;
    badge.style.color = s.accent;
    var bdot = el('span', 'sl-badge-dot');
    bdot.style.background = s.accent;
    badge.appendChild(bdot);
    badge.appendChild(document.createTextNode(q.category || 'Other'));
    titleRow.appendChild(badge);
    var uses = state.usage[q._key] || 0;
    titleRow.appendChild(el('span', 'sl-uses', uses ? usesText(uses) : ''));
    content.appendChild(titleRow);
    if (q.description) content.appendChild(highlighted('p', 'sl-card-desc', q.description, state.search));

    var tags = tagsOf(q);
    if (tags.length) {
      var tw = el('div', 'sl-tags');
      tags.forEach(function (t) {
        var activeTag = t.toLowerCase() === state.filterTag.toLowerCase();
        var tb = highlighted('button', 'sl-tag sl-tag-btn' + (activeTag ? ' active' : ''), t, state.search);
        tb.type = 'button';
        tb.title = activeTag ? 'Stop filtering by this tag' : 'Show queries tagged ' + t;
        tb.setAttribute('aria-pressed', activeTag ? 'true' : 'false');
        tb.addEventListener('click', function (e) {
          e.stopPropagation();
          state.filterTag = activeTag ? '' : t;
          renderMainOnly();
        });
        tw.appendChild(tb);
      });
      content.appendChild(tw);
    }
    if (!open && q.spl) content.appendChild(splBlock('div', 'sl-card-preview', previewLine(q.spl, state.search), state.search));
    hdr.appendChild(content);

    var fav = isFavorite(q._key);
    var star = el('button', 'sl-star' + (fav ? ' on' : ''));
    star.type = 'button';
    star.title = fav ? 'Remove from starred' : 'Star this query';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', fav ? 'true' : 'false');
    star.appendChild(icon(null, fav ? 'starOn' : 'star'));
    star.addEventListener('click', function (e) { e.stopPropagation(); toggleFavorite(q._key); });
    var icons = el('div', 'sl-card-icons');
    icons.appendChild(star);
    icons.appendChild(icon('sl-chevron', 'chevron'));
    hdr.appendChild(icons);
    c.appendChild(hdr);

    if (open) {
      var exp = el('div', 'sl-card-expanded');
      exp.appendChild(splBlock('pre', 'sl-spl' + (state.wrap ? ' wrap' : ''), q.spl, state.search));

      var footer = el('div', 'sl-card-footer');
      footer.appendChild(el('span', 'sl-meta-text',
        'Added ' + (q.created_at || '?') + ' by ' + (q.author || '?')));

      var actions = el('div', 'sl-actions');

      var copyBtn = el('button', 'sl-btn-sm sl-btn-copy', 'Copy SPL');
      copyBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(q.spl || '');
        confirmButton(copyBtn, 'Copied');
        recordUse(q._key);
      });
      actions.appendChild(copyBtn);

      var linkBtn = el('button', 'sl-btn-sm sl-btn-edit sl-btn-link', 'Copy link');
      linkBtn.title = 'Copy a link that opens this query';
      linkBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(linkTo(q._key));
        confirmButton(linkBtn, 'Link copied');
      });
      actions.appendChild(linkBtn);

      var openLink = el('a', 'sl-btn-sm sl-btn-open', 'Open in Search \u2197');
      openLink.href = searchUrl(q.spl || '');
      openLink.target = '_blank';
      openLink.addEventListener('click', function (e) { e.stopPropagation(); recordUse(q._key); });
      actions.appendChild(openLink);

      var editBtn = el('button', 'sl-btn-sm sl-btn-edit', 'Edit');
      editBtn.addEventListener('click', function (e) { e.stopPropagation(); openModal(q); });
      actions.appendChild(editBtn);

      var delBtn = el('button', 'sl-btn-sm sl-btn-delete', 'Delete');
      delBtn.addEventListener('click', function (e) { e.stopPropagation(); deleteQuery(q._key); });
      actions.appendChild(delBtn);

      footer.appendChild(actions);
      exp.appendChild(footer);
      c.appendChild(exp);
    }
    return c;
  }

  /* ── Modal ────────────────────────────────────────────────── */
  function formSignature(f) {
    return JSON.stringify([f.title, f.description, f.spl, f.category, f.tags]);
  }

  function catSignature(rows) {
    return JSON.stringify(rows.map(function (c) { return [c._key, c.name, c.color]; }));
  }

  function formDirty() {
    if (state.modal === 'categories') return !!state.catDraft && catSignature(state.catDraft) !== state.formSnapshot;
    return !!state.form &&
      (formSignature(state.form) !== state.formSnapshot || !!(state.tagInput || '').trim());
  }

  function openModal(q) {
    state.formError = null;
    state.confirmDiscard = false;
    state.tagInput = '';
    if (q) {
      state.modal = 'edit';
      state.form = {
        _key: q._key, title: q.title || '', description: q.description || '',
        spl: q.spl || '', category: q.category || 'Other',
        tags: tagsOf(q), created_at: q.created_at, author: q.author
      };
    } else {
      state.modal = 'new';
      var cat = findCategory(state.filterCat) ? state.filterCat : categoryNames()[0];
      state.form = { title: '', description: '', spl: '', category: cat, tags: [] };
    }
    state.formSnapshot = formSignature(state.form);
    render();
    focusModalField('.sl-input');
  }

  function focusModalField(selector) {
    var f = $root[0].querySelector('.sl-modal ' + selector);
    if (f) f.focus();
  }

  function closeModal() {
    state.modal = null; state.form = null; state.formError = null;
    state.catDraft = null; state.catError = null;
    state.formSnapshot = null; state.confirmDiscard = false;
    render();
  }

  // Cancel/Save buttons, or the "Discard your changes?" prompt in their place
  function modalActions(save) {
    var actions = el('div', 'sl-modal-actions');
    if (state.confirmDiscard) {
      actions.className += ' sl-discard';
      actions.setAttribute('role', 'alert');
      actions.appendChild(el('span', 'sl-discard-text', 'Discard your changes?'));
      var keep = el('button', 'sl-btn-cancel sl-discard-keep', 'Keep editing');
      keep.addEventListener('click', function () {
        state.confirmDiscard = false;
        render();
        focusModalField('.sl-input');
      });
      var discard = el('button', 'sl-btn-discard', 'Discard');
      discard.addEventListener('click', closeModal);
      actions.appendChild(keep);
      actions.appendChild(discard);
    } else {
      var cancel = el('button', 'sl-btn-cancel', 'Cancel');
      cancel.addEventListener('click', cancelModal);
      actions.appendChild(cancel);
      actions.appendChild(save);
    }
    return actions;
  }

  function dialog(modal, save) {
    var overlay = el('div', 'sl-overlay');
    modal.appendChild(modalActions(save));
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !state.confirmDiscard) {
        e.preventDefault();
        save.click();
      }
    });
    overlay.appendChild(modal);
    return overlay;
  }

  function cancelModal() {
    if (!formDirty()) { closeModal(); return; }
    state.confirmDiscard = true;
    render();
    focusModalField('.sl-discard-keep');
  }

  function renderModal() {
    var f = state.form;

    var modal = el('div', 'sl-modal');
    modal.appendChild(el('h2', null, state.modal === 'new' ? 'Add query' : 'Edit query'));
    if (state.formError) modal.appendChild(el('p', 'sl-form-error', state.formError));

    function input(label, key, placeholder) {
      modal.appendChild(el('label', 'sl-label', label));
      var i = el('input', 'sl-input');
      i.type = 'text'; i.value = f[key]; i.placeholder = placeholder || '';
      i.addEventListener('input', function () { f[key] = this.value; });
      modal.appendChild(i);
    }

    input('Title *', 'title', 'e.g. Failed Logins Last Hour');
    input('Description', 'description', 'What does this query detect or measure?');

    modal.appendChild(el('label', 'sl-label', 'Category'));
    var sel = el('select', 'sl-select');
    var options = categoryNames();
    // Keep a query's category selectable even if it has since been removed
    if (f.category && options.indexOf(f.category) === -1) options.push(f.category);
    options.forEach(function (cat) {
      var o = el('option', null, cat);
      o.value = cat;
      if (f.category === cat) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { f.category = this.value; });
    modal.appendChild(sel);

    modal.appendChild(el('label', 'sl-label', 'SPL query *'));
    var ta = el('textarea', 'sl-textarea');
    ta.value = f.spl;
    ta.placeholder = 'index=\u2026 sourcetype=\u2026\n| stats count by \u2026';
    ta.addEventListener('input', function () { f.spl = this.value; });
    modal.appendChild(ta);

    modal.appendChild(el('label', 'sl-label', 'Tags'));
    var tagRow = el('div', 'sl-tagrow');
    var tagInp = el('input', 'sl-input');
    tagInp.type = 'text';
    tagInp.placeholder = 'security, authentication, \u2026';
    tagInp.value = state.tagInput;
    tagInp.addEventListener('input', function () { state.tagInput = this.value; });
    tagInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addTag(); }
    });
    var tagBtn = el('button', 'sl-btn-tagadd', 'Add');
    tagBtn.addEventListener('click', addTag);
    tagRow.appendChild(tagInp);
    tagRow.appendChild(tagBtn);
    modal.appendChild(tagRow);

    var tagWrap = el('div', 'sl-tags');
    tagWrap.style.marginBottom = '16px';
    f.tags.forEach(function (t) {
      var tag = el('span', 'sl-tag', t);
      var rm = el('button', 'sl-tag-rm', '\u00d7');
      rm.addEventListener('click', function () {
        f.tags = f.tags.filter(function (x) { return x !== t; });
        render();
      });
      tag.appendChild(rm);
      tagWrap.appendChild(tag);
    });
    modal.appendChild(tagWrap);

    var save = el('button', 'sl-btn-primary', 'Save query');
    save.addEventListener('click', function () {
      if (!f.title.trim() || !f.spl.trim()) {
        state.formError = 'Title and SPL query are required.';
        render();
        return;
      }
      var payload = {
        title: f.title, description: f.description, spl: f.spl,
        category: f.category, tags: f.tags.join(','),
        created_at: f.created_at || today(), author: f.author || currentUser()
      };
      if (state.modal === 'new') createQuery(payload);
      else updateQuery(f._key, payload);
    });
    return dialog(modal, save);
  }

  function addTag() {
    var t = (state.tagInput || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (t && state.form.tags.indexOf(t) === -1) state.form.tags.push(t);
    state.tagInput = '';
    render();
    focusModalField('.sl-tagrow .sl-input');
  }

  /* ── Category management ──────────────────────────────────── */
  function openCategoryModal() {
    state.modal = 'categories';
    state.confirmDiscard = false;
    state.catError = null;
    state.catDraft = state.categories.map(function (c) {
      return { _key: c._key, name: c.name, color: c.color, origName: c.name };
    });
    state.formSnapshot = catSignature(state.catDraft);
    render();
  }

  function newCategoryKey(name) {
    var base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'category';
    return base + '-' + Date.now().toString(36);
  }

  function categoryError(rows) {
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i].name.trim(), lower = name.toLowerCase();
      if (!name) return 'Every category needs a name.';
      if (name.length > 40) return '"' + name.slice(0, 40) + '…" is too long (40 characters at most).';
      if (RESERVED_NAMES.indexOf(lower) !== -1) return '"' + name + '" is reserved; choose another name.';
      if (seen[lower]) return 'There are two categories called "' + name + '".';
      seen[lower] = true;
    }
    return null;
  }

  // Saves the edited list. Renamed categories carry their queries along, and
  // queries in deleted categories move to Other. Query records are rewritten in
  // full (the KV Store has no partial update), so this is an admin action.
  function saveCategories() {
    var rows = state.catDraft;
    var err = categoryError(rows);
    if (err) { state.catError = err; render(); return; }

    var docs = rows.map(function (r, i) {
      return { _key: r._key || newCategoryKey(r.name), name: r.name.trim(), color: r.color, order: i };
    });
    var kept = {};
    docs.forEach(function (d) { kept[d._key] = true; });
    var removed = state.categories.filter(function (c) { return !kept[c._key]; });
    var moves = {};
    rows.forEach(function (r) {
      if (r.origName && r.origName !== r.name.trim()) moves[r.origName] = r.name.trim();
    });
    removed.forEach(function (c) { moves[c.name] = OTHER; });
    var changed = state.queries.filter(function (q) { return moves.hasOwnProperty(q.category); })
      .map(function (q) {
        var u = $.extend({}, q, { category: moves[q.category], updated_at: today() });
        delete u._user;
        return u;
      });

    var requests = [kv('POST', '/batch_save', docs, CAT_COLLECTION)];
    removed.forEach(function (c) {
      // An already-deleted record (404) counts as done
      var d = $.Deferred();
      kv('DELETE', '/' + encodeURIComponent(c._key), null, CAT_COLLECTION)
        .done(function () { d.resolve(); })
        .fail(function (xhr) { if (xhr.status === 404) d.resolve(); else d.reject(xhr); });
      requests.push(d.promise());
    });
    if (changed.length) requests.push(kv('POST', '/batch_save', changed));

    $.when.apply($, requests).done(function () {
      state.categories = docs;
      state.queries.forEach(function (q) {
        if (moves.hasOwnProperty(q.category)) q.category = moves[q.category];
      });
      if (moves.hasOwnProperty(state.filterCat)) state.filterCat = moves[state.filterCat];
      normalizeFilters();
      closeModal();
    }).fail(function (xhr) {
      state.catError = (xhr && xhr.status === 403)
        ? 'You do not have permission to change categories.'
        : 'Could not save categories (HTTP ' + (xhr ? xhr.status : '?') + '). Please try again.';
      render();
    });
  }

  function renderCategoryModal() {
    var rows = state.catDraft;
    var modal = el('div', 'sl-modal sl-cat-modal');
    modal.appendChild(el('h2', null, 'Categories'));
    modal.appendChild(el('p', 'sl-cat-hint',
      'Renaming a category updates the queries in it. Deleting one moves its queries to Other.'));
    if (state.catError) modal.appendChild(el('p', 'sl-form-error', state.catError));

    var counts = {};
    state.queries.forEach(function (q) { counts[q.category] = (counts[q.category] || 0) + 1; });

    var list = el('div', 'sl-cat-list');
    rows.forEach(function (r, i) {
      var isOther = r.origName === OTHER;
      var row = el('div', 'sl-cat-row');

      var dot = el('span', 'sl-cat-swatch');
      dot.style.background = (PALETTE[r.color] || PALETTE.slate)[state.theme].accent;
      row.appendChild(dot);

      var color = el('select', 'sl-cat-color');
      color.setAttribute('aria-label', 'Color for ' + (r.name || 'new category'));
      Object.keys(PALETTE).forEach(function (k) {
        var o = el('option', null, k.charAt(0).toUpperCase() + k.slice(1));
        o.value = k;
        if (r.color === k) o.selected = true;
        color.appendChild(o);
      });
      color.addEventListener('change', function () {
        r.color = this.value;
        dot.style.background = PALETTE[r.color][state.theme].accent;
      });
      row.appendChild(color);

      var name = el('input', 'sl-input sl-cat-name');
      name.type = 'text';
      name.value = r.name;
      name.maxLength = 40;
      name.placeholder = 'Category name';
      name.setAttribute('aria-label', 'Category name');
      if (isOther) { name.disabled = true; name.title = 'Other is the fallback category and cannot be renamed'; }
      name.addEventListener('input', function () { r.name = this.value; });
      row.appendChild(name);

      var n = r.origName ? (counts[r.origName] || 0) : 0;
      row.appendChild(el('span', 'sl-cat-uses', n === 1 ? '1 query' : n + ' queries'));

      function move(delta) {
        var j = i + delta;
        rows.splice(j, 0, rows.splice(i, 1)[0]);
        render();
        var btns = $root[0].querySelectorAll('.sl-cat-row')[j].querySelectorAll('.sl-cat-move');
        (btns[delta < 0 ? 0 : 1] || btns[0]).focus();
      }
      var up = el('button', 'sl-cat-icon-btn sl-cat-move');
      up.type = 'button';
      up.setAttribute('aria-label', 'Move up');
      up.title = 'Move up';
      up.disabled = i === 0;
      up.appendChild(icon(null, 'up'));
      up.addEventListener('click', function () { move(-1); });
      var down = el('button', 'sl-cat-icon-btn sl-cat-move sl-cat-down');
      down.type = 'button';
      down.setAttribute('aria-label', 'Move down');
      down.title = 'Move down';
      down.disabled = i === rows.length - 1;
      down.appendChild(icon(null, 'up'));
      down.addEventListener('click', function () { move(1); });
      var del = el('button', 'sl-cat-icon-btn sl-cat-delete');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete ' + (r.name || 'category'));
      del.title = isOther ? 'Other cannot be deleted' : 'Delete';
      del.disabled = isOther;
      del.appendChild(icon(null, 'trash'));
      del.addEventListener('click', function () { rows.splice(i, 1); render(); });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(del);
      list.appendChild(row);
    });
    modal.appendChild(list);

    var add = el('button', 'sl-btn-tagadd sl-cat-add', '+ Add category');
    add.type = 'button';
    add.addEventListener('click', function () {
      var used = rows.map(function (r) { return r.color; });
      var free = Object.keys(PALETTE).filter(function (k) { return used.indexOf(k) === -1; });
      rows.splice(Math.max(rows.length - 1, 0), 0, { _key: null, name: '', color: free[0] || 'slate', origName: null });
      render();
      var names = $root[0].querySelectorAll('.sl-cat-name');
      names[Math.max(rows.length - 2, 0)].focus();
    });
    modal.appendChild(add);

    var save = el('button', 'sl-btn-primary', 'Save categories');
    save.addEventListener('click', saveCategories);
    return dialog(modal, save);
  }

  /* ── Boot ─────────────────────────────────────────────────── */
  // Pasting a different link into the address bar changes only the hash
  window.addEventListener('hashchange', function () {
    readHash();
    if (state.loading) return;
    normalizeFilters();
    var opened = applyPendingOpen();
    render();
    if (opened) revealCard(opened);
  });

  // Closing or reloading the tab with an unsaved draft triggers the browser's own warning
  window.addEventListener('beforeunload', function (e) {
    if (state.modal && formDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  readHash();
  render();
  loadAll();
});
