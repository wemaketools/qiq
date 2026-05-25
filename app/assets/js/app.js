/* ============================================================
   QuoteIQ — app shell, router, options panel, theming
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});
  const { ui, data, fmt } = QIQ;

  const VERSION = 'v0.4.2';
  QIQ.VERSION = VERSION;

  const NAV = [
    { key: 'overview', label: 'Overview',       icon: 'overview' },
    { key: 'pipeline', label: 'Pipeline',       icon: 'pipeline' },
    { key: 'brokers',  label: 'Brokers',        icon: 'brokers' },
    { key: 'rm',       label: 'RM Performance', icon: 'rm' },
    { key: 'loss',     label: 'Loss Analysis',  icon: 'loss' },
    { key: 'alerts',   label: 'Alerts',         icon: 'alerts', alertBadge: true },
    { key: 'reports',  label: 'Reports',        icon: 'reports' },
  ];

  const PREFS = 'qiq_prefs_v1';

  const state = (QIQ.state = {
    userKey: 'head',
    user: data.ROLES.head,
    theme: 'light', accent: 'teal', density: 'comfortable',
    route: 'overview', sub: null, param: null,
    pipelineTab: 'quotes',
    filters: { line: 'All', broker: 'All', rm: 'All', region: 'All', status: 'All', channel: 'All', stage: 'All', search: '' },
  });

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
      if (p.theme) state.theme = p.theme;
      if (p.accent) state.accent = p.accent;
      if (p.density) state.density = p.density;
      if (p.userKey && data.ROLES[p.userKey]) { state.userKey = p.userKey; state.user = data.ROLES[p.userKey]; }
    } catch (e) {}
  }
  function savePrefs() {
    localStorage.setItem(PREFS, JSON.stringify({ theme: state.theme, accent: state.accent, density: state.density, userKey: state.userKey }));
  }
  function applyAttrs() {
    const r = document.documentElement;
    r.setAttribute('data-theme', state.theme);
    r.setAttribute('data-accent', state.accent);
    r.setAttribute('data-density', state.density);
  }

  function alertCount() { return data.quotes.filter((q) => data.isAtRisk(q)).length; }

  /* ---------- shell ---------- */
  function renderShell() {
    const app = document.getElementById('app');
    app.removeAttribute('aria-busy');
    app.innerHTML = `
      <div class="shell">
        <aside class="sidebar" id="sidebar">
          <div class="brand">
            ${ui.brandMark(40)}
            <div>
              <div class="name">QuoteIQ</div>
              <div class="sub">Quotation Intelligence</div>
              <span class="ver">Prototype ${VERSION}</span>
            </div>
          </div>
          <nav class="nav" id="nav"></nav>
          <button class="user-card" id="userCard" title="Switch persona / settings">
            <span class="avatar" id="avatar">${state.user.initials}</span>
            <span class="who"><span class="n" id="uName">${ui.esc(state.user.name)}</span><span class="r" id="uRole">${ui.esc(state.user.role)}</span></span>
            <span class="chev">${ui.icon('sliders', 16)}</span>
          </button>
        </aside>

        <div class="main">
          <header class="topbar">
            <button class="icon-btn hamburger" id="hamburger" title="Menu">${ui.icon('menu', 18)}</button>
            <div class="topbar-title"><h1 id="pageTitle">Overview</h1><div class="page-sub" id="pageSub"></div></div>
            <div class="spacer"></div>
            <div class="searchbox"><span>${ui.icon('search', 16)}</span><input id="search" placeholder="Search quotes, clients, brokers…" /></div>
            <button class="icon-btn" id="bell" title="Alerts">${ui.icon('alerts', 18)}<span class="count" id="bellCount">0</span></button>
            <button class="icon-btn" id="helpBtn" title="Demo tour">${ui.icon('help', 18)}</button>
            <button class="btn" id="exportBtn">${ui.icon('download', 16)} <span class="exp-label">Export</span></button>
            <button class="btn primary" id="newQuoteBtn">${ui.icon('plus', 16)} <span class="nq-label">New Quote</span></button>
            <button class="icon-btn" id="gearBtn" title="Options">${ui.icon('sliders', 18)}</button>
          </header>
          <main class="content" id="content"></main>
          <footer class="appfoot">
            <span>© 2025 QuoteIQ. All rights reserved.</span>
            <span class="mid">All amounts in BWP · Prototype ${VERSION}</span>
            <span class="row" style="gap:6px;">Data as of 31 May 2025, 08:30 SAST ${ui.icon('refresh', 13)}</span>
          </footer>
        </div>
      </div>
      <div class="drawer" id="drawer"></div>
    `;
    renderNav();
    bindShell();
    refreshUserUI();
  }

  function renderNav() {
    const ac = alertCount();
    document.getElementById('nav').innerHTML = NAV.map((n) => `
      <a class="nav-item" data-route="${n.key}" href="#/${n.key}">
        ${ui.icon(n.icon, 19)}<span>${n.label}</span>
        ${n.alertBadge ? `<span class="badge">${ac}</span>` : ''}
      </a>`).join('');
    const bc = document.getElementById('bellCount'); if (bc) bc.textContent = ac;
  }

  function refreshUserUI() {
    document.getElementById('avatar').textContent = state.user.initials;
    document.getElementById('uName').textContent = state.user.name;
    document.getElementById('uRole').textContent = state.user.role;
    // readonly: hide New Quote
    const nq = document.getElementById('newQuoteBtn');
    nq.style.display = state.user.readonly ? 'none' : '';
    // RM scope label hint
  }

  function bindShell() {
    document.getElementById('hamburger').onclick = () => toggleSidebar(true);
    document.getElementById('gearBtn').onclick = openOptions;
    document.getElementById('userCard').onclick = openOptions;
    document.getElementById('bell').onclick = () => go('alerts');
    document.getElementById('helpBtn').onclick = () => QIQ.forms.tour();
    document.getElementById('newQuoteBtn').onclick = () => QIQ.forms.newQuote();
    document.getElementById('exportBtn').onclick = onExport;
    const s = document.getElementById('search');
    s.value = state.filters.search;
    s.oninput = debounce(() => { state.filters.search = s.value.trim(); renderRoute(); }, 220);
    document.getElementById('scrim').onclick = closeOverlays;
  }

  function toggleSidebar(open) {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('open', open);
    showScrim(open);
  }
  function showScrim(on) { const s = document.getElementById('scrim'); if (on) s.hidden = false; else s.hidden = true; }
  function closeOverlays() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('drawer').classList.remove('open');
    showScrim(false);
  }

  /* ---------- options drawer ---------- */
  function openOptions() {
    const d = document.getElementById('drawer');
    d.innerHTML = optionsMarkup();
    requestAnimationFrame(() => { d.classList.add('open'); showScrim(true); });
    bindOptions();
  }
  function themeBtn(key, label, ic) {
    return `<button data-theme="${key}" class="${state.theme === key ? 'active' : ''}">${ui.icon(ic, 17)}${label}</button>`;
  }
  function optionsMarkup() {
    const accents = [['teal', '#18a999'], ['indigo', '#5b6ee0'], ['emerald', '#15a36a'], ['amber', '#d9892a']];
    return `
      <div class="dh"><h3>Prototype options</h3><button class="icon-btn" id="drawerClose">${ui.icon('x', 18)}</button></div>
      <div class="db">
        <div class="opt-group">
          <div class="lbl">Theme</div>
          <div class="seg" id="themeSeg">
            ${themeBtn('light', 'Light', 'sun')}
            ${themeBtn('dark', 'Dark', 'moon')}
            ${themeBtn('slate', 'Slate', 'contrast')}
          </div>
        </div>
        <div class="opt-group">
          <div class="lbl">Accent colour</div>
          <div class="swatches" id="accentRow">
            ${accents.map(([k, c]) => `<button class="swatch ${state.accent === k ? 'active' : ''}" data-accent="${k}" style="background:${c}" title="${k}"></button>`).join('')}
          </div>
        </div>
        <div class="opt-group">
          <div class="lbl">Density</div>
          <div class="seg" id="densitySeg">
            <button data-density="comfortable" class="${state.density === 'comfortable' ? 'active' : ''}">Comfortable</button>
            <button data-density="compact" class="${state.density === 'compact' ? 'active' : ''}">Compact</button>
          </div>
        </div>
        <div class="opt-group">
          <div class="lbl">View as persona</div>
          <div class="persona-list" id="personaList">
            ${Object.entries(data.ROLES).map(([k, r]) => `
              <button class="persona ${state.userKey === k ? 'active' : ''}" data-persona="${k}">
                <span class="avatar" style="width:30px;height:30px;font-size:11px;">${r.initials}</span>
                <span><span class="pn">${ui.esc(r.name)}</span><br><span class="pr">${ui.esc(r.role)}</span></span>
                <span class="ro">${r.readonly ? 'read-only' : (r.scope || '')}</span>
              </button>`).join('')}
          </div>
        </div>
        <div class="opt-group">
          <div class="lbl">Feedback</div>
          <label class="persona" style="cursor:pointer;justify-content:space-between;">
            <span><span class="pn">Comment mode</span><br><span class="pr">Hover a block & click + to comment</span></span>
            <input type="checkbox" id="optCmtToggle" ${QIQ.feedback && QIQ.feedback.isOn() ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent);" />
          </label>
          <button class="btn" id="optCmtOpen" style="width:100%;justify-content:center;margin-top:8px;">${ui.icon('msg', 16)} Open comments <span class="badge-soft" id="optCmtCount" style="margin-left:6px;">${QIQ.feedback ? QIQ.feedback.count() : 0}</span></button>
        </div>
        <div class="opt-group">
          <div class="lbl">Demo data</div>
          <button class="btn danger" id="resetData" style="width:100%;justify-content:center;">${ui.icon('refresh', 16)} Reset demo data</button>
          <p class="muted" style="font-size:11.5px;margin:10px 2px 0;">Restores the seeded sample book and clears any quotes you captured this session.</p>
        </div>
        <div class="opt-group">
          <button class="btn ghost" id="replayTour" style="width:100%;justify-content:center;">${ui.icon('help', 16)} Replay demo tour</button>
        </div>
      </div>`;
  }
  function bindOptions() {
    document.getElementById('drawerClose').onclick = closeOverlays;
    document.querySelectorAll('#themeSeg button').forEach((b) => b.onclick = () => { state.theme = b.dataset.theme; applyAttrs(); savePrefs(); openOptions(); renderRoute(); });
    document.querySelectorAll('#accentRow .swatch').forEach((b) => b.onclick = () => { state.accent = b.dataset.accent; applyAttrs(); savePrefs(); openOptions(); renderRoute(); });
    document.querySelectorAll('#densitySeg button').forEach((b) => b.onclick = () => { state.density = b.dataset.density; applyAttrs(); savePrefs(); openOptions(); });
    document.querySelectorAll('#personaList .persona').forEach((b) => b.onclick = () => switchPersona(b.dataset.persona));
    document.getElementById('resetData').onclick = () => {
      data.reset(); ui.toast('Demo data reset to seed', 'good'); renderNav(); renderRoute();
    };
    document.getElementById('replayTour').onclick = () => { closeOverlays(); QIQ.forms.tour(); };
    const ct = document.getElementById('optCmtToggle'); if (ct) ct.onchange = () => { closeOverlays(); QIQ.feedback.setMode(ct.checked); };
    const co = document.getElementById('optCmtOpen'); if (co) co.onclick = () => { closeOverlays(); QIQ.feedback.openPanel(); };
  }
  function switchPersona(key) {
    if (!data.ROLES[key]) return;
    state.userKey = key; state.user = data.ROLES[key]; savePrefs();
    refreshUserUI(); renderNav();
    ui.toast('Viewing as ' + state.user.name + ' · ' + state.user.role);
    // land on the persona's default screen for effect
    go(state.user.landing || 'overview');
    openOptions();
  }

  /* ---------- routing ---------- */
  function parseHash() {
    const h = (location.hash || '#/overview').replace(/^#\//, '');
    const parts = h.split('/');
    return { route: parts[0] || 'overview', a: parts[1] || null };
  }
  function go(route, a) { location.hash = '#/' + route + (a ? '/' + a : ''); }

  function onHashChange() {
    const { route, a } = parseHash();
    if (route === 'quote' && a) { state.route = 'quote'; state.param = a; }
    else if (route === 'pipeline') { state.route = 'pipeline'; state.pipelineTab = (a === 'conversion') ? 'conversion' : 'quotes'; }
    else { state.route = NAV.find((n) => n.key === route) ? route : 'overview'; state.param = null; }
    closeOverlays();
    renderRoute();
    document.getElementById('content').scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function scopedCtx() {
    const f = Object.assign({}, state.filters);
    if (state.user.scope === 'rm') f.scopeRM = data.ROLES.rm.name === state.user.name ? state.user.name : 'Lesedi Phiri';
    return { filters: f, user: state.user };
  }

  function renderRoute() {
    QIQ.charts.disposeAll();
    const content = document.getElementById('content');
    const ctx = scopedCtx();
    let screen;
    if (state.route === 'quote') screen = QIQ.screens.quoteDetail(state.param);
    else screen = QIQ.screens[state.route] ? QIQ.screens[state.route]() : QIQ.screens.overview();

    // active nav + title
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.route === (state.route === 'quote' ? 'pipeline' : state.route)));
    document.getElementById('pageTitle').textContent = screen.title;
    document.getElementById('pageSub').textContent = screen.sub || '';
    document.title = 'QuoteIQ — ' + screen.title;

    content.innerHTML = screen.html;
    if (screen.mount) screen.mount(content);
    bindContent(content);
    if (QIQ.feedback) QIQ.feedback.afterRender(content);
  }

  // delegated bindings for filter bar, tabs, table rows, card links
  function bindContent(root) {
    root.querySelectorAll('[data-filter]').forEach((sel) => {
      sel.onchange = () => { state.filters[sel.dataset.filter] = sel.value; renderRoute(); };
    });
    root.querySelectorAll('[data-clearfilters]').forEach((b) => b.onclick = () => {
      state.filters = { line: 'All', broker: 'All', rm: 'All', region: 'All', status: 'All', channel: 'All', stage: 'All', search: state.filters.search };
      renderRoute();
    });
    root.querySelectorAll('[data-go]').forEach((el) => el.onclick = (e) => { e.preventDefault(); go(el.dataset.go, el.dataset.goa || null); });
    root.querySelectorAll('[data-quote]').forEach((el) => el.onclick = () => go('quote', el.dataset.quote));
    root.querySelectorAll('[data-tab]').forEach((el) => el.onclick = () => go('pipeline', el.dataset.tab === 'conversion' ? 'conversion' : null));
  }

  /* ---------- shared filter bar ---------- */
  function filterBar(opts) {
    opts = opts || {};
    const f = state.filters;
    const optList = (arr, cur) => ['All'].concat(arr).map((v) => `<option ${v === cur ? 'selected' : ''}>${ui.esc(v)}</option>`).join('');
    const brokers = data.BROKERS.map((b) => b.name);
    const rms = data.RMS.map((r) => r.name);
    return `<div class="filterbar">
      <div class="field date"><label>Date Range</label>
        <div class="input" style="display:flex;align-items:center;gap:8px;cursor:default;">${fmt.dateShort ? '1 Jun 2024 – 31 May 2025' : ''} ${ui.icon('calendar', 15)}</div></div>
      <div class="field"><label>Product Line</label><select class="select" data-filter="line">${optList(data.LINES, f.line)}</select></div>
      <div class="field"><label>Broker</label><select class="select" data-filter="broker">${optList(brokers, f.broker)}</select></div>
      <div class="field"><label>RM</label><select class="select" data-filter="rm">${optList(rms, f.rm)}</select></div>
      <div class="field"><label>Region</label><select class="select" data-filter="region">${optList(data.REGIONS, f.region)}</select></div>
      ${opts.status ? `<div class="field"><label>Status</label><select class="select" data-filter="status"><option ${f.status==='All'?'selected':''}>All</option><option ${f.status==='open'?'selected':''} value="open">Open</option><option ${f.status==='won'?'selected':''} value="won">Won</option><option ${f.status==='lost'?'selected':''} value="lost">Lost</option></select></div>` : ''}
      <div class="field"><label>&nbsp;</label><button class="btn" data-clearfilters>${ui.icon('refresh', 15)} Clear filters</button></div>
    </div>`;
  }

  /* ---------- export ---------- */
  function onExport() {
    const ctx = scopedCtx();
    const rows = data.filter(ctx.filters);
    exportCSV(rows, 'quoteiq-quotes-' + state.route + '.csv');
    ui.toast('Exported ' + rows.length + ' quotes to CSV', 'good');
  }
  function exportCSV(quotes, filename) {
    const cols = ['id', 'client', 'broker', 'rm', 'team', 'channel', 'line', 'cover', 'premium', 'stage', 'status', 'dateReceived', 'dateSent', 'decisionDate', 'boundPremium', 'lossReason', 'competitor'];
    const head = cols.join(',');
    const body = quotes.map((q) => cols.map((c) => {
      let v = q[c];
      if (/date|decisionDate/i.test(c) && v) v = new Date(v).toISOString().slice(0, 10);
      if (v == null) v = '';
      v = String(v).replace(/"/g, '""');
      return /[",\n]/.test(v) ? `"${v}"` : v;
    }).join(',')).join('\n');
    const blob = new Blob([head + '\n' + body], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  /* ---------- expose app API for screens/forms ---------- */
  QIQ.app = { go, renderRoute, renderNav, filterBar, exportCSV, scopedCtx, alertCount, closeOverlays, toggleSidebar };

  /* ---------- boot ---------- */
  function boot() {
    data.load();
    loadPrefs();
    applyAttrs();
    renderShell();
    if (QIQ.feedback) QIQ.feedback.init();
    window.addEventListener('hashchange', onHashChange);
    if (!location.hash) location.hash = '#/' + (state.user.landing || 'overview');
    onHashChange();
    if (!localStorage.getItem('qiq_seen_tour')) { setTimeout(() => QIQ.forms.tour(), 450); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
