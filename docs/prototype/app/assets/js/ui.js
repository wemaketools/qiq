/* ============================================================
   QuoteIQ — shared UI (icons, brand, component builders)
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});

  const P = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    pipeline: '<path d="M3 4.5h18l-7 8v6.5l-4 2v-8.5z"/>',
    brokers: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    rm: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    loss: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
    alerts: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    sun: '<circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
    dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    trendingUp: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/>',
    msg: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="14" x2="15" y2="14"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    handshake: '<path d="M11 17l2 2a1 1 0 0 0 3-3"/><path d="M14 14l2.5 2.5a1 1 0 0 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 0 1-1.42 0l-2.38-2.38a1 1 0 0 0-1.42 0L2 9"/><path d="M22 9l-2.12-2.12"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  };

  function icon(name, size) {
    const p = P[name] || '';
    const s = size || 20;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  function brandMark(size) {
    const s = size || 38;
    return `<svg class="mark" viewBox="0 0 40 40" width="${s}" height="${s}" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0c2b2c"/>
      <path d="M20 8c6.2 0 11 4.6 11 10.3 0 3.2-1.5 6-3.9 7.9l3 3-2.9 2.9-3.3-3.3A11.6 11.6 0 0 1 20 36C13.8 36 9 31.4 9 25.7 9 16.1 14 8 20 8z" fill="#2bb6a3"/>
      <path d="M20 14.5c-3.1 1.8-5 4.9-5 8.4 0 2.1.8 3.9 2.1 5.2.5-3.2 2.3-6.1 5.1-8.2 1.6-1.2 2.6-2.4 3.2-3.7-1.5-1-3.4-1.7-5.4-1.7z" fill="#0c2b2c" opacity=".55"/>
    </svg>`;
  }

  function leaf(size) {
    const s = size || 13;
    return `<svg class="leaf" viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M5 21c0-9 6-15 15-16-1 9-6 15-15 16z"/></svg>`;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function delta(dir, text, good, vs) {
    const mod = (dir === 'up' && !good) ? ' bad' : (dir === 'down' && good) ? ' good' : '';
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
    return `<div class="delta ${dir}${mod}">${arrow} ${esc(text)} <span class="vs">${esc(vs || 'vs Apr 1–30')}</span></div>`;
  }

  function kpi(o) {
    return `<div class="kpi">
      <div class="top"><div class="ic">${icon(o.icon, 18)}</div><div class="label">${esc(o.label)}</div></div>
      <div class="val">${o.cur ? `<span class="cur">${o.cur}</span>` : ''}${o.value}</div>
      ${o.delta ? delta(o.delta.dir, o.delta.text, o.delta.good, o.delta.vs) : ''}
    </div>`;
  }

  function stageChip(stage) {
    const st = QIQ.data.STAGES[stage] || { label: stage, cls: 'st-new' };
    return `<span class="chip ${st.cls}">${esc(st.label)}</span>`;
  }
  function flagChip(flag) {
    const f = QIQ.data.FLAGS[flag]; if (!f) return '';
    return `<span class="chip flag ${f.tone}">${esc(f.label)}</span>`;
  }
  function chip(text, cls) { return `<span class="chip ${cls || 'tone-muted'}">${esc(text)}</span>`; }

  function cardHead(title, sub, opts) {
    opts = opts || {};
    return `<div class="card-head"><div><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>${opts.menu ? `<button class="menu-dots" title="More">${icon('dots', 16)}</button>` : ''}</div>`;
  }
  function cardLink(text, route) { return `<a class="card-link" href="#/${route}">${esc(text)} ${icon('arrowRight', 14)}</a>`; }

  function legendList(rows, fmt) {
    return `<div class="legend-list" style="display:flex;flex-direction:column;gap:9px;">${rows.map((r) => `
      <div class="row between" style="font-size:12.5px;">
        <div class="row" style="gap:8px;min-width:0;"><span class="dotc" style="width:9px;height:9px;border-radius:3px;background:${r.color};flex:none;"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.name)}</span></div>
        <div class="nowrap"><b>${fmt ? fmt(r.value) : r.value.toLocaleString()}</b> <span class="muted">${r.pct != null ? '(' + r.pct + '%)' : ''}</span></div>
      </div>`).join('')}</div>`;
  }

  // rows: [{name, value, valLabel, sec?, color?}] — horizontal ranked list with optional secondary column
  function rankList(rows, opts) {
    opts = opts || {};
    const max = Math.max.apply(null, rows.map((r) => r.value)) || 1;
    return `<div class="rank-list">
      ${opts.secLabel ? `<div class="rl-row rl-head"><span></span><span></span><span class="rl-sec">${opts.valHead || ''}</span><span class="rl-sec">${esc(opts.secLabel)}</span></div>` : ''}
      ${rows.map((r) => `<div class="rl-row">
        <div class="rl-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="rl-track"><div class="rl-bar" style="width:${Math.max(4, r.value / max * 100).toFixed(1)}%;${r.color ? `background:${r.color};` : ''}"></div></div>
        <div class="rl-val">${esc(r.valLabel)}</div>
        ${r.sec != null ? `<div class="rl-sec">${esc(r.sec)}</div>` : ''}
      </div>`).join('')}
    </div>`;
  }

  function ageCell(days) {
    const cls = days >= 18 ? 'age-hot' : days >= 12 ? 'age-warm' : '';
    return `<span class="${cls}">${days} days</span>`;
  }

  let toastTimer;
  function toast(msg, kind) {
    const host = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = (kind === 'good' ? icon('checkCircle', 17) : icon('info', 17)) + '<span>' + esc(msg) + '</span>';
    host.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s, transform .3s'; el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 2600);
  }

  QIQ.ui = { icon, brandMark, leaf, esc, delta, kpi, stageChip, flagChip, chip, cardHead, cardLink, legendList, rankList, ageCell, toast };
})();
