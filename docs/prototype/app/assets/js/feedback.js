/* ============================================================
   QuoteIQ — feedback / commenting mode
   Hover a block → add a comment. Comments link to page+item,
   persist to localStorage, and export as Markdown with the
   prototype version stamped at the top.
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});
  const ui = QIQ.ui;

  const KEY = 'qiq_comments_v1';
  const RKEY = 'qiq_reviewer';
  const COMMENTABLE = '.kpi, table.tbl tbody tr, .action-row, .card';

  const F = {
    on: false,
    reviewer: '',
    comments: [],
    _seq: 1,
    currentBlock: null,
  };

  /* ---------- persistence ---------- */
  function load() {
    try { F.comments = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { F.comments = []; }
    F.reviewer = localStorage.getItem(RKEY) || '';
    F._seq = F.comments.reduce((m, c) => Math.max(m, c.seq || 0), 0) + 1;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(F.comments)); } catch (e) {} }

  /* ---------- route + anchor helpers ---------- */
  const NAV_LABELS = { overview: 'Overview', pipeline: 'Pipeline', brokers: 'Brokers', rm: 'RM Performance', loss: 'Loss Analysis', alerts: 'Alerts', reports: 'Reports' };
  function routeKey() {
    const s = QIQ.state;
    if (s.route === 'pipeline') return 'pipeline:' + s.pipelineTab;
    if (s.route === 'quote') return 'quote:' + s.param;
    return s.route;
  }
  function routeLabel() {
    const s = QIQ.state;
    if (s.route === 'pipeline') return 'Pipeline · ' + (s.pipelineTab === 'conversion' ? 'Conversion' : 'Quotes');
    if (s.route === 'quote') return 'Quote ' + s.param;
    return NAV_LABELS[s.route] || s.route;
  }
  function clean(t) { return (t || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

  function anchorOf(block) {
    let type = 'card', key = '', label = 'Card';
    if (block.classList.contains('kpi')) {
      type = 'kpi'; key = clean(block.querySelector('.label') && block.querySelector('.label').textContent); label = 'KPI: ' + key;
    } else if (block.matches('tr')) {
      const qid = block.dataset.quote || '';
      const strong = clean(block.querySelector('.t-strong') && block.querySelector('.t-strong').textContent);
      type = 'row'; key = qid || strong; label = 'Row: ' + (strong || qid || 'item');
    } else if (block.classList.contains('action-row')) {
      type = 'action'; key = clean(block.querySelector('.at') && block.querySelector('.at').textContent); label = 'Item: ' + key;
    } else {
      const t = block.querySelector('.card-head .t');
      key = clean(t && t.textContent) || 'Card'; type = 'card'; label = 'Card: ' + key;
    }
    return { type, key, label, route: routeKey(), routeLabel: routeLabel() };
  }

  function findBlock(c) {
    const root = document.getElementById('content');
    if (!root || !c.anchor) return null;
    const a = c.anchor;
    if (a.type === 'kpi') return [].find.call(root.querySelectorAll('.kpi'), (el) => clean(el.querySelector('.label') && el.querySelector('.label').textContent) === a.key);
    if (a.type === 'row') return [].find.call(root.querySelectorAll('table.tbl tbody tr'), (el) => (el.dataset.quote || '') === a.key || clean(el.querySelector('.t-strong') && el.querySelector('.t-strong').textContent) === a.key);
    if (a.type === 'action') return [].find.call(root.querySelectorAll('.action-row'), (el) => clean(el.querySelector('.at') && el.querySelector('.at').textContent) === a.key);
    return [].find.call(root.querySelectorAll('.card'), (el) => { const t = el.querySelector('.card-head .t'); return (clean(t && t.textContent) || 'Card') === a.key; });
  }

  /* ---------- DOM scaffolding (once) ---------- */
  let hoverEl, popEl, drawerEl;
  function init() {
    load();
    // hover highlight + add badge
    hoverEl = document.createElement('div');
    hoverEl.id = 'cmt-hover';
    hoverEl.innerHTML = `<button class="cmt-badge" title="Add comment">+</button>`;
    document.body.appendChild(hoverEl);
    hoverEl.querySelector('.cmt-badge').addEventListener('click', (e) => { e.stopPropagation(); if (F.currentBlock) openPopover(F.currentBlock); });

    // floating toolbar
    const bar = document.createElement('div');
    bar.id = 'cmt-bar';
    bar.innerHTML = `<span class="dotlive"></span><span>Comment mode</span><span class="badge-soft" id="cmtBarCount">0</span>
      <button class="b-panel" id="cmtBarPanel">Comments</button><button class="b-done" id="cmtBarDone">Done</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#cmtBarPanel').onclick = openPanel;
    bar.querySelector('#cmtBarDone').onclick = () => setMode(false);

    // comments drawer
    drawerEl = document.createElement('div');
    drawerEl.id = 'cmtDrawer';
    document.body.appendChild(drawerEl);

    // hover tracking on the content area (content element is stable for app lifetime)
    const content = document.getElementById('content');
    if (content) {
      content.addEventListener('mousemove', onMove);
      content.addEventListener('mouseleave', (e) => {
        // don't hide when the pointer is moving onto our own overlay/badge
        if (popOpen) return;
        if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#cmt-hover')) return;
        hideHover();
      });
    }
    updateBarCount();
  }

  /* ---------- hover ---------- */
  let popOpen = false;
  function onMove(e) {
    if (!F.on || popOpen) return;
    if (e.target.closest && e.target.closest('#cmt-hover')) return;
    const block = e.target.closest(COMMENTABLE);
    if (!block) { hideHover(); return; }
    F.currentBlock = block;
    const r = block.getBoundingClientRect();
    hoverEl.style.display = 'block';
    hoverEl.style.left = r.left - 2 + 'px';
    hoverEl.style.top = r.top - 2 + 'px';
    hoverEl.style.width = r.width + 4 + 'px';
    hoverEl.style.height = r.height + 4 + 'px';
  }
  function hideHover() { hoverEl.style.display = 'none'; F.currentBlock = null; }

  /* ---------- popover ---------- */
  function openPopover(block) {
    closePopover();
    popOpen = true;
    const anchor = anchorOf(block);
    const r = block.getBoundingClientRect();
    popEl = document.createElement('div');
    popEl.id = 'cmt-pop';
    popEl.innerHTML = `
      <div class="anc">${ui.icon('pin', 13)} ${ui.esc(anchor.routeLabel)} › ${ui.esc(anchor.label)}</div>
      <textarea id="cmtText" placeholder="Add your feedback on this item…"></textarea>
      <div class="row"><button class="btn ghost sm" id="cmtCancel">Cancel</button><button class="btn primary sm" id="cmtSave">Add comment</button></div>`;
    document.body.appendChild(popEl);
    // position: prefer below-left of the badge, clamp to viewport
    const pw = 300, ph = popEl.offsetHeight || 170;
    let left = Math.min(r.left, window.innerWidth - pw - 12);
    let top = r.top + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, window.innerHeight - ph - 12);
    popEl.style.left = Math.max(12, left) + 'px';
    popEl.style.top = top + 'px';
    hoverEl.style.display = 'none';
    const ta = popEl.querySelector('#cmtText'); ta.focus();
    popEl.querySelector('#cmtCancel').onclick = closePopover;
    popEl.querySelector('#cmtSave').onclick = () => {
      const text = ta.value.trim(); if (!text) { ta.focus(); return; }
      addComment(anchor, text); closePopover();
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) popEl.querySelector('#cmtSave').click(); if (e.key === 'Escape') closePopover(); });
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
  }
  function outside(e) { if (popEl && !popEl.contains(e.target)) closePopover(); }
  function closePopover() { if (popEl) { popEl.remove(); popEl = null; } popOpen = false; document.removeEventListener('mousedown', outside); }

  /* ---------- mutations ---------- */
  function addComment(anchor, text) {
    const c = { id: 'c' + Date.now() + Math.floor(Math.random() * 1000), seq: F._seq++, anchor, text, by: F.reviewer || '', version: QIQ.VERSION, ts: Date.now() };
    F.comments.push(c); save();
    ui.toast('Comment added', 'good');
    updateBarCount(); renderPanel(); placePins();
  }
  function deleteComment(id) { F.comments = F.comments.filter((c) => c.id !== id); save(); updateBarCount(); renderPanel(); placePins(); }
  function clearAll() {
    if (!F.comments.length) return;
    if (!confirm('Delete all ' + F.comments.length + ' comments? This cannot be undone.')) return;
    F.comments = []; save(); updateBarCount(); renderPanel(); placePins(); ui.toast('All comments cleared');
  }

  /* ---------- pins ---------- */
  function placePins() {
    const content = document.getElementById('content'); if (!content) return;
    content.querySelectorAll('.cmt-pin').forEach((p) => p.remove());
    content.querySelectorAll('.cmt-pinned').forEach((b) => b.classList.remove('cmt-pinned'));
    if (!F.on) return;
    const rk = routeKey();
    F.comments.forEach((c, i) => {
      if (c.anchor.route !== rk) return;
      const block = findBlock(c); if (!block) return;
      block.classList.add('cmt-pinned');
      const pin = document.createElement('span');
      pin.className = 'cmt-pin'; pin.textContent = c.seq; pin.title = c.text;
      pin.addEventListener('click', (e) => { e.stopPropagation(); openPanel(); flash(c.id); });
      block.appendChild(pin);
    });
  }

  /* ---------- comments drawer ---------- */
  function openPanel() { renderPanel(); drawerEl.classList.add('open'); }
  function closePanel() { drawerEl.classList.remove('open'); }
  function updateBarCount() { const el = document.getElementById('cmtBarCount'); if (el) el.textContent = F.comments.length; const o = document.getElementById('optCmtCount'); if (o) o.textContent = F.comments.length; }

  function renderPanel() {
    if (!drawerEl) return;
    const groups = {};
    F.comments.forEach((c) => { const k = c.anchor.routeLabel; (groups[k] = groups[k] || []).push(c); });
    const hasC = F.comments.length > 0;
    drawerEl.innerHTML = `
      <div class="dh"><h3 style="font-size:16px;">Feedback ${hasC ? '· ' + F.comments.length : ''}</h3><button class="icon-btn" id="cmtClose">${ui.icon('x', 18)}</button></div>
      <div class="vh">
        ${hasC ? `<div style="margin-bottom:8px;">QuoteIQ Prototype <b>${ui.esc(QIQ.VERSION)}</b></div>` : ''}
        <input class="cmt-name-field" id="cmtReviewer" placeholder="Your name (optional)" value="${ui.esc(F.reviewer)}" />
      </div>
      <div class="db" id="cmtList">
        ${hasC ? Object.keys(groups).map((g) => `
          <div class="cmt-group-h">${ui.esc(g)}</div>
          ${groups[g].map((c) => `
            <div class="cmt-item" data-cid="${c.id}">
              <div class="n"><span class="num">${c.seq}</span><span class="anc">${ui.esc(c.anchor.label)}</span></div>
              <div class="tx">${ui.esc(c.text)}</div>
              <div class="meta"><span>${ui.esc(c.by || F.reviewer || 'unnamed')} · ${c.version}</span><button class="del" data-del="${c.id}" title="Delete">${ui.icon('x', 14)}</button></div>
            </div>`).join('')}
        `).join('') : `<div class="empty">${ui.icon('msg', 40)}<div>No comments yet.</div><p class="muted" style="font-size:12px;max-width:240px;margin:8px auto 0;">Turn on Comment mode, hover any card or row, and click the + to leave feedback.</p></div>`}
      </div>
      <div class="df">
        <button class="btn primary" id="cmtCopy" style="flex:1;justify-content:center;" ${hasC ? '' : 'disabled'}>${ui.icon('download', 15)} Copy all</button>
        <button class="btn danger" id="cmtClear" ${hasC ? '' : 'disabled'}>${ui.icon('x', 15)} Clear</button>
      </div>`;
    drawerEl.querySelector('#cmtClose').onclick = closePanel;
    const rev = drawerEl.querySelector('#cmtReviewer');
    rev.onchange = () => { F.reviewer = rev.value.trim(); localStorage.setItem(RKEY, F.reviewer); };
    drawerEl.querySelector('#cmtCopy').onclick = copyAll;
    drawerEl.querySelector('#cmtClear').onclick = clearAll;
    drawerEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); deleteComment(b.dataset.del); });
    drawerEl.querySelectorAll('.cmt-item').forEach((it) => it.onclick = () => jumpTo(it.dataset.cid));
  }

  function flash(id) {
    const el = drawerEl.querySelector(`.cmt-item[data-cid="${id}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  function jumpTo(id) {
    const c = F.comments.find((x) => x.id === id); if (!c) return;
    const target = c.anchor.route;
    const cur = routeKey();
    const nav = () => { const b = findBlock(c); if (b) { b.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.classList.add('cmt-pinned'); } flash(id); };
    if (target === cur) { nav(); return; }
    // navigate to the comment's page, then locate
    if (target.startsWith('pipeline:')) QIQ.app.go('pipeline', target.split(':')[1] === 'conversion' ? 'conversion' : null);
    else if (target.startsWith('quote:')) QIQ.app.go('quote', target.split(':')[1]);
    else QIQ.app.go(target);
    setTimeout(nav, 360);
  }

  /* ---------- export ---------- */
  function copyAll() {
    const groups = {};
    F.comments.forEach((c) => { const k = c.anchor.routeLabel; (groups[k] = groups[k] || []).push(c); });
    let out = `QuoteIQ Prototype Feedback — ${QIQ.VERSION}\n`;
    out += `Reviewer: ${F.reviewer || '—'}\n`;
    out += `Date: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}\n`;
    out += `Comments: ${F.comments.length}\n`;
    Object.keys(groups).forEach((g) => {
      out += `\n## ${g}\n`;
      groups[g].forEach((c) => { out += `${c.seq}. [${c.anchor.label}] ${c.text}${c.version !== QIQ.VERSION ? ' (' + c.version + ')' : ''}\n`; });
    });
    copyText(out.trim());
  }
  function copyText(str) {
    const done = () => ui.toast('Feedback copied to clipboard', 'good');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(done).catch(() => fallbackCopy(str));
    } else fallbackCopy(str);
  }
  function fallbackCopy(str) {
    // file:// can block the async clipboard API — offer a selectable textarea
    const m = document.createElement('div');
    m.className = 'modal-scrim';
    m.innerHTML = `<div class="modal" style="width:560px;"><div class="mh"><h3>Copy feedback</h3><button class="icon-btn" id="fcX">${ui.icon('x', 18)}</button></div>
      <div class="mb"><p class="muted" style="margin:0 0 10px;font-size:12.5px;">Select all and copy (⌘/Ctrl+C):</p><textarea style="width:100%;height:300px;font-family:var(--mono);font-size:12px;border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--surface);color:var(--text);">${ui.esc(str)}</textarea></div></div>`;
    document.body.appendChild(m);
    const ta = m.querySelector('textarea'); ta.focus(); ta.select();
    const close = () => m.remove();
    m.querySelector('#fcX').onclick = close;
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
  }

  /* ---------- mode ---------- */
  function setMode(on) {
    F.on = on;
    document.body.classList.toggle('cmt-on', on);
    if (!on) { hideHover(); closePopover(); }
    updateBarCount();
    QIQ.app.renderRoute(); // refresh to add/remove pins
    if (on) ui.toast('Comment mode on — hover a block and click +'); else closePanel();
    const t = document.getElementById('optCmtToggle'); if (t) t.checked = on;
  }

  /* ---------- public API ---------- */
  QIQ.feedback = {
    init,
    afterRender() { placePins(); },
    setMode,
    toggle() { setMode(!F.on); },
    isOn() { return F.on; },
    openPanel,
    count() { return F.comments.length; },
  };
})();
