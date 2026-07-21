/* ============================================================
   QuoteIQ — forms, quote detail, reports, tour
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});
  const { ui, data, fmt } = QIQ;

  /* ---------- modal infra ---------- */
  function openModal(html, cls) {
    const host = document.getElementById('modal-host');
    host.innerHTML = `<div class="modal-scrim" id="mscrim"><div class="modal ${cls || ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    const scrim = document.getElementById('mscrim');
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeModal(); });
    document.addEventListener('keydown', escClose);
    return host.querySelector('.modal');
  }
  function closeModal() { document.getElementById('modal-host').innerHTML = ''; document.removeEventListener('keydown', escClose); }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  QIQ.forms = { closeModal };

  /* ---------- NEW QUOTE ---------- */
  QIQ.forms.newQuote = function () {
    const opt = (arr, sel) => arr.map((v) => `<option ${v === sel ? 'selected' : ''}>${ui.esc(v)}</option>`).join('');
    const brokers = data.BROKERS.map((b) => b.name);
    const rms = data.RMS.map((r) => r.name);
    const lineOpts = data.LINES;
    const m = openModal(`
      <div class="mh"><div><h3>New Quote Request</h3><div class="ms">Capture an incoming quotation request</div></div><button class="icon-btn" id="nqClose">${ui.icon('x', 18)}</button></div>
      <div class="mb">
        <form id="nqForm">
          <div class="form-grid">
            <div class="form-section-title">Request</div>
            <div class="fg full"><label>Client / Prospect <span class="req">*</span></label><input class="input" name="client" required placeholder="e.g. Botswana Mining Co." /></div>
            <div class="fg"><label>Request Channel <span class="req">*</span></label><select class="select" name="channel">${opt(data.CHANNELS)}</select></div>
            <div class="fg"><label>Broker / Partner</label><select class="select" name="broker"><option value="">— Direct (no broker) —</option>${opt(brokers)}</select></div>
            <div class="fg"><label>Relationship Manager <span class="req">*</span></label><select class="select" name="rm">${opt(rms, QIQ.state.user.scope === 'rm' ? QIQ.state.user.name : rms[4])}</select></div>
            <div class="fg"><label>Date Received <span class="req">*</span></label><input class="input" type="date" name="dateReceived" value="2025-05-31" /></div>

            <div class="form-section-title">Quote details</div>
            <div class="fg"><label>Product Line <span class="req">*</span></label><select class="select" name="line" id="nqLine">${opt(lineOpts)}</select></div>
            <div class="fg"><label>Type of Cover <span class="req">*</span></label><select class="select" name="cover" id="nqCover">${opt(data.PRODUCTS[lineOpts[0]].covers)}</select></div>
            <div class="fg"><label>Sum Insured (BWP)</label><input class="input" type="number" name="sumInsured" placeholder="e.g. 25000000" /></div>
            <div class="fg"><label>Quoted Premium (BWP) <span class="req">*</span></label><input class="input" type="number" name="premium" required placeholder="e.g. 450000" /></div>

            <div class="form-section-title">Client profile</div>
            <div class="fg"><label>Segment</label><select class="select" name="segment">${opt(data.SEGMENTS)}</select></div>
            <div class="fg"><label>Industry</label><select class="select" name="industry">${opt(data.INDUSTRIES)}</select></div>
            <div class="fg"><label>Region</label><select class="select" name="region">${opt(data.REGIONS)}</select></div>
            <div class="fg"><label>Client Type</label>
              <select class="select" name="ctype"><option>Corporate</option><option>SME</option><option>Public Sector</option><option>Individual</option></select></div>
            <div class="fg full row" style="gap:20px;align-items:center;">
              <label class="row" style="gap:8px;font-weight:600;"><input type="checkbox" name="existing" /> Existing client</label>
              <label class="row" style="gap:8px;font-weight:600;"><input type="checkbox" name="strategic" /> Strategic account</label>
            </div>
            <div class="fg full"><label>Notes</label><textarea name="notes" placeholder="Context, special requirements, deadlines…"></textarea></div>
          </div>
        </form>
      </div>
      <div class="mf"><button class="btn" id="nqCancel">Cancel</button><button class="btn primary" id="nqSave">${ui.icon('plus', 16)} Capture quote</button></div>
    `);
    const form = m.querySelector('#nqForm');
    const lineSel = m.querySelector('#nqLine'), coverSel = m.querySelector('#nqCover');
    lineSel.onchange = () => { coverSel.innerHTML = data.PRODUCTS[lineSel.value].covers.map((c) => `<option>${c}</option>`).join(''); };
    m.querySelector('#nqClose').onclick = closeModal;
    m.querySelector('#nqCancel').onclick = closeModal;
    m.querySelector('#nqSave').onclick = () => {
      if (!form.reportValidity()) return;
      const f = new FormData(form);
      const brokerName = f.get('broker') || null;
      const broker = brokerName ? data.BROKERS.find((b) => b.name === brokerName) : null;
      const rm = data.RMS.find((r) => r.name === f.get('rm'));
      const received = new Date(f.get('dateReceived') || '2025-05-31').getTime();
      const q = data.addQuote({
        client: f.get('client'), clientType: f.get('ctype'), industry: f.get('industry'),
        segment: f.get('segment'), region: f.get('region'),
        existing: !!f.get('existing'), strategic: !!f.get('strategic'),
        broker: brokerName, brokerTier: broker ? broker.tier : null, brokerBranch: broker ? broker.branch : null, brokerContact: broker ? broker.contact : null,
        rm: f.get('rm'), team: rm ? rm.team : 'Corporate & Commercial', channel: f.get('channel'),
        line: f.get('line'), cover: f.get('cover'),
        sumInsured: +f.get('sumInsured') || 0, premium: +f.get('premium') || 0,
        dateReceived: received, dateAssigned: received,
        notes: f.get('notes') || '',
      });
      closeModal();
      QIQ.app.renderNav();
      ui.toast('Quote ' + q.id + ' captured', 'good');
      QIQ.app.go('quote', q.id);
    };
  };

  /* ---------- QUOTE DETAIL ---------- */
  QIQ.forms.quoteDetail = function (id) {
    const q = data.byId(id);
    if (!q) return { title: 'Quote not found', sub: '', html: `<div class="empty">${ui.icon('search', 40)}<div>Quote ${ui.esc(id)} not found.</div><p><a class="card-link" data-go="pipeline" href="#/pipeline">Back to pipeline</a></p></div>`, mount(root) { root.querySelectorAll('[data-go]').forEach((e) => e.onclick = (ev) => { ev.preventDefault(); QIQ.app.go('pipeline'); }); } };

    const ro = QIQ.state.user.readonly;
    const tat = data.turnaround(q), dd = data.decisionDays(q), uw = data.uwDays(q);
    const steps = buildStepper(q);
    const outcome = q.status === 'won'
      ? `<div class="card" style="border-color:color-mix(in srgb,var(--good) 40%,var(--border));">
           <div class="card-head"><div class="t" style="color:var(--good);">${ui.icon('trophy', 16)} Won</div></div>
           <dl class="kv"><dt>Bound premium</dt><dd class="money">BWP ${fmt.money(q.boundPremium || q.premium)}</dd><dt>Decision date</dt><dd>${fmt.date(q.decisionDate)}</dd><dt>Decision time</dt><dd>${dd != null ? dd + ' days' : '—'}</dd></dl>
         </div>`
      : q.status === 'lost'
      ? `<div class="card" style="border-color:color-mix(in srgb,var(--bad) 40%,var(--border));">
           <div class="card-head"><div class="t" style="color:var(--bad);">${ui.icon('loss', 16)} Lost — ${ui.esc(q.lossReason)}</div></div>
           <dl class="kv">
             <dt>Competitor</dt><dd>${ui.esc(q.competitor || 'Unknown')}</dd>
             ${q.competitorPremium ? `<dt>Competitor premium</dt><dd class="money">BWP ${fmt.money(q.competitorPremium)}</dd><dt>Price gap</dt><dd>${fmt.pct((q.premium - q.competitorPremium) / q.premium, 0)}</dd>` : ''}
             <dt>Decision date</dt><dd>${fmt.date(q.decisionDate)}</dd>
           </dl>
           ${q.lossComment ? `<p class="muted" style="margin:12px 0 0;font-size:12.5px;">“${ui.esc(q.lossComment)}”</p>` : ''}
         </div>`
      : `<div class="card">
           <div class="card-head"><div class="t">Loss intelligence</div></div>
           <p class="muted" style="font-size:12.5px;margin:0;">Captured when a quote is marked Lost — structured reason, competitor, price gap and commentary feed the Loss Analysis dashboard.</p>
         </div>`;

    const actions = ro ? `<span class="badge-soft">${ui.icon('shield', 13)} Read-only (ExCo view)</span>`
      : q.status !== 'open'
      ? `<span class="badge-soft">Closed ${q.status === 'won' ? 'Won' : 'Lost'} · ${fmt.date(q.decisionDate)}</span>`
      : `<button class="btn" id="qaFollow">${ui.icon('msg', 16)} Log follow-up</button>
         <button class="btn" id="qaAdvance">${ui.icon('arrowRight', 16)} Advance stage</button>
         <button class="btn primary" id="qaWon">${ui.icon('trophy', 16)} Mark Won</button>
         <button class="btn danger" id="qaLost">${ui.icon('x', 16)} Mark Lost</button>`;

    const html = `
      <a class="card-link" data-go="pipeline" href="#/pipeline" style="margin-bottom:14px;">${ui.icon('chevronRight', 14)} Back to pipeline</a>
      <div class="detail-head">
        <div style="flex:1;min-width:0;">
          <div class="row wrap" style="gap:10px;align-items:center;">
            <span class="big">${ui.esc(q.client)}</span>
            ${ui.stageChip(q.stage)} ${(q.flags || []).map(ui.flagChip).join(' ')}
            ${q.strategic ? ui.chip('★ Strategic', 'tone-good') : ''}
          </div>
          <div class="muted" style="margin-top:4px;">${q.id} · Ref ${ui.esc(q.ref)} · ${ui.esc(q.line)} — ${ui.esc(q.cover)} · ${ui.esc(q.existing ? 'Existing' : 'New')} client</div>
        </div>
        <div class="right"><div class="muted" style="font-size:12px;">Quoted premium</div><div class="big">BWP ${fmt.money(q.premium)}</div></div>
      </div>
      <div class="row wrap" style="gap:10px;margin-bottom:18px;">${actions}</div>

      <div class="card" style="margin-bottom:var(--gap);overflow-x:auto;">
        <div class="stepper">${steps}</div>
      </div>

      <div class="grid c12">
        <div class="grid" style="gap:var(--gap);">
          <div class="card">
            ${ui.cardHead('Quote details')}
            <dl class="kv">
              <dt>Broker / Partner</dt><dd>${ui.esc(q.broker || 'Direct')}${q.brokerTier ? ' · ' + q.brokerTier : ''}</dd>
              <dt>Broker contact</dt><dd>${ui.esc(q.brokerContact || '—')}</dd>
              <dt>Relationship Manager</dt><dd>${ui.esc(q.rm)} <span class="muted">(${ui.esc(q.team)})</span></dd>
              <dt>Request channel</dt><dd>${ui.esc(q.channel)}</dd>
              <dt>Segment / Industry</dt><dd>${ui.esc(q.segment)} · ${ui.esc(q.industry)}</dd>
              <dt>Region</dt><dd>${ui.esc(q.region)}</dd>
              <dt>Sum insured</dt><dd class="money">BWP ${fmt.money(q.sumInsured)}</dd>
            </dl>
          </div>
          <div class="card">
            ${ui.cardHead('Process & SLA tracking')}
            <dl class="kv">
              <dt>Date received</dt><dd>${fmt.date(q.dateReceived)}</dd>
              <dt>Date prepared</dt><dd>${fmt.date(q.datePrepared)}</dd>
              <dt>Date sent</dt><dd>${fmt.date(q.dateSent)}</dd>
              <dt>Request → quote</dt><dd>${tat != null ? tat + ' days ' + slaTag(tat <= data.SLA_TARGET) : '—'}</dd>
              <dt>Valid until</dt><dd>${q.validUntil ? fmt.date(q.validUntil) + (data.isExpired(q) ? ' ' + ui.chip('Expired', 'tone-bad') : data.isExpiring(q) ? ' ' + ui.chip('Soon', 'tone-warn') : '') : '—'}</dd>
              <dt>Underwriter</dt><dd>${ui.esc(q.underwriter || '—')}</dd>
              <dt>Underwriting SLA</dt><dd>${q.slaStatus ? (uw + ' days ' + slaTag(q.slaStatus === 'within')) : '—'}</dd>
            </dl>
          </div>
          <div class="card">
            ${ui.cardHead('Follow-up log', q.followUpCount + ' follow-ups · next ' + (q.nextFollowUp ? fmt.date(q.nextFollowUp) : 'n/a'))}
            ${(q.followUps && q.followUps.length) ? `<div class="timeline">${q.followUps.slice().reverse().map((f) => `<div class="tl-row"><div class="tdot"></div><div><div class="tw">${ui.esc(f.note)}</div><div class="tt">${fmt.date(f.date)} · ${ui.esc(f.by)}</div></div></div>`).join('')}</div>` : '<p class="muted" style="font-size:12.5px;">No follow-ups logged yet.</p>'}
            ${(!ro && q.status === 'open') ? `<div class="row mt" style="gap:8px;"><input class="input" id="fuNote" placeholder="Log a follow-up note…" style="flex:1;"/><button class="btn primary" id="fuAdd">Add</button></div>` : ''}
          </div>
        </div>

        <div class="grid" style="gap:var(--gap);align-content:start;">
          ${outcome}
          <div class="card">
            ${ui.cardHead('Documents & version')}
            <dl class="kv"><dt>Quote reference</dt><dd>${ui.esc(q.ref)}</dd><dt>Version</dt><dd>v1.${q.followUpCount}</dd><dt>Document</dt><dd>${q.dateSent ? ui.chip('Quote.pdf', 'tone-info') : ui.chip('Not issued', 'tone-muted')}</dd></dl>
          </div>
          <div class="card">
            ${ui.cardHead('Audit trail')}
            <div class="timeline">
              ${(q.history && q.history.length ? q.history.slice().reverse() : auditFallback(q)).map((h) => `<div class="tl-row"><div class="tdot"></div><div><div class="tw">${ui.esc(h.action)}</div><div class="tt">${fmt.date(h.ts)} · ${ui.esc(h.by)}</div></div></div>`).join('')}
            </div>
          </div>
        </div>
      </div>`;

    return {
      title: 'Quote ' + q.id, sub: q.client,
      html,
      mount(root) {
        root.querySelectorAll('[data-go]').forEach((e) => e.onclick = (ev) => { ev.preventDefault(); QIQ.app.go('pipeline'); });
        const adv = root.querySelector('#qaAdvance'); if (adv) adv.onclick = () => { data.advance(q); QIQ.app.renderNav(); ui.toast('Advanced to ' + data.stageLabel(q.stage), 'good'); QIQ.app.renderRoute(); };
        const won = root.querySelector('#qaWon'); if (won) won.onclick = () => { data.markWon(q); QIQ.app.renderNav(); ui.toast('Marked Won — premium bound', 'good'); QIQ.app.renderRoute(); };
        const lost = root.querySelector('#qaLost'); if (lost) lost.onclick = () => markLostModal(q);
        const fu = root.querySelector('#fuAdd'); if (fu) fu.onclick = () => { const v = root.querySelector('#fuNote').value.trim(); if (!v) return; data.logFollowUp(q, v); QIQ.app.renderNav(); ui.toast('Follow-up logged', 'good'); QIQ.app.renderRoute(); };
        const fol = root.querySelector('#qaFollow'); if (fol) fol.onclick = () => { const i = root.querySelector('#fuNote'); if (i) i.focus(); };
      },
    };
  };

  function slaTag(ok) { return ok ? ui.chip('Within SLA', 'tone-good') : ui.chip('Breached', 'tone-bad'); }
  function auditFallback(q) {
    const h = [{ ts: q.dateReceived, action: 'Quote request captured', by: q.createdBy }];
    if (q.datePrepared) h.push({ ts: q.datePrepared, action: 'Quote prepared', by: q.underwriter || q.rm });
    if (q.dateSent) h.push({ ts: q.dateSent, action: 'Quote sent to client', by: q.rm });
    if (q.decisionDate) h.push({ ts: q.decisionDate, action: q.status === 'won' ? 'Marked Won' : 'Marked Lost — ' + q.lossReason, by: q.rm });
    return h;
  }

  function buildStepper(q) {
    const order = data.STAGE_ORDER;
    let html = '';
    order.forEach((key, i) => {
      let cls = '';
      if (q.status === 'open') { if (i < q.reachedIdx) cls = 'done'; else if (i === q.reachedIdx) cls = 'current'; }
      else { if (i <= q.reachedIdx) cls = 'done'; }
      const ts = stepTs(q, i);
      html += `<div class="step ${cls}">
        <div class="node"><div class="dot">${cls === 'done' ? '✓' : i + 1}</div><div class="nl">${data.STAGES[key].label}</div><div class="ts">${ts}</div></div>
        <div class="bar ${cls === 'done' ? 'done' : ''}"></div>
      </div>`;
    });
    const oc = q.status === 'won' ? 'done' : q.status === 'lost' ? 'lost' : '';
    const ocLabel = q.status === 'won' ? 'Won' : q.status === 'lost' ? 'Lost' : 'Decision';
    const ocSym = q.status === 'won' ? '✓' : q.status === 'lost' ? '✕' : '•';
    html += `<div class="step ${oc}"><div class="node"><div class="dot">${ocSym}</div><div class="nl">${ocLabel}</div><div class="ts">${q.decisionDate ? fmt.dateShort(q.decisionDate) : ''}</div></div></div>`;
    return html;
  }
  function stepTs(q, i) {
    if (i === 0) return fmt.dateShort(q.dateReceived);
    if (i === 2 && q.datePrepared) return fmt.dateShort(q.datePrepared);
    if (i === 3 && q.dateSent) return fmt.dateShort(q.dateSent);
    return '';
  }

  function markLostModal(q) {
    const m = openModal(`
      <div class="mh"><div><h3>Mark Quote Lost</h3><div class="ms">${q.id} · ${ui.esc(q.client)} · BWP ${fmt.money(q.premium)}</div></div><button class="icon-btn" id="mlClose">${ui.icon('x', 18)}</button></div>
      <div class="mb"><form id="mlForm"><div class="form-grid">
        <div class="fg full"><label>Loss reason <span class="req">*</span></label><select class="select" name="reason" required>${data.LOSS_REASONS.map((r) => `<option>${r}</option>`).join('')}</select></div>
        <div class="fg"><label>Competitor (if known)</label><select class="select" name="competitor"><option value="">— Unknown —</option>${data.COMPETITORS.map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div class="fg"><label>Competitor premium (BWP)</label><input class="input" type="number" name="comp" placeholder="optional" /></div>
        <div class="fg full"><label>Loss commentary</label><textarea name="comment" placeholder="Why was this lost? Any detail that helps pricing / proposition…"></textarea></div>
      </div></form></div>
      <div class="mf"><button class="btn" id="mlCancel">Cancel</button><button class="btn danger" id="mlSave">Mark Lost</button></div>
    `);
    m.querySelector('#mlClose').onclick = closeModal;
    m.querySelector('#mlCancel').onclick = closeModal;
    m.querySelector('#mlSave').onclick = () => {
      const form = m.querySelector('#mlForm'); if (!form.reportValidity()) return;
      const f = new FormData(form);
      data.markLost(q, f.get('reason'), f.get('competitor') || null, +f.get('comp') || null, f.get('comment') || '');
      closeModal(); QIQ.app.renderNav(); ui.toast('Quote marked Lost — ' + f.get('reason')); QIQ.app.renderRoute();
    };
  }

  /* ---------- REPORTS (print-ready) ---------- */
  QIQ.forms.openReport = function (key) {
    const qs = data.filter(QIQ.app.scopedCtx().filters);
    const u = QIQ._screenUtil;
    const m = u.metrics(qs);
    const titles = { exec: 'Executive Weekly Report', pipeline: 'Pipeline & Conversion Report', broker: 'Broker Performance Report', rm: 'RM Performance Report', loss: 'Loss Analysis Report', sla: 'SLA / Turnaround Report' };
    const kpiCell = (l, v) => `<div class="rs-kpi" style="padding:12px 14px;border-radius:10px;"><div style="font-size:11px;color:#5b6b75;font-weight:600;">${l}</div><div style="font-size:20px;font-weight:740;color:#0e3536;">${v}</div></div>`;

    const body = `<div class="grid" style="grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0;">
      ${kpiCell('Total Quotes', m.total.toLocaleString())}
      ${kpiCell('Open Pipeline', 'BWP ' + fmt.money(m.openPremium, true))}
      ${kpiCell('Conversion Rate', fmt.pct(m.conversion))}
      ${kpiCell('Won Premium', 'BWP ' + fmt.money(m.wonPremium, true))}
      ${kpiCell('Avg Turnaround', m.avgTurnaround.toFixed(1) + ' days')}
      ${kpiCell('Quotes at Risk', m.atRiskCount.toLocaleString())}
    </div>`;

    let table = '';
    if (key === 'broker' || key === 'rm') {
      const isB = key === 'broker';
      const rows = (isB ? data.BROKERS : data.RMS).map((x) => {
        const items = data.quotes.filter((q) => (isB ? q.broker : q.rm) === x.name);
        const won = items.filter((q) => q.status === 'won');
        const dec = won.length + items.filter((q) => q.status === 'lost').length;
        return { name: x.name, volume: items.length, conv: dec ? won.length / dec : 0, wonP: data.sum(won, (q) => q.boundPremium || q.premium) };
      }).sort((a, b) => b.wonP - a.wonP);
      table = repTable([isB ? 'Broker' : 'RM', 'Quotes', 'Conversion', 'Won Premium'], rows.map((r) => [r.name, r.volume.toLocaleString(), fmt.pct(r.conv), 'BWP ' + fmt.money(r.wonP, true)]));
    } else if (key === 'loss') {
      const lost = qs.filter((q) => q.status === 'lost');
      const rows = data.LOSS_REASONS.map((r) => ({ r, p: data.sum(lost.filter((q) => q.lossReason === r), (q) => q.premium), c: lost.filter((q) => q.lossReason === r).length })).filter((x) => x.c).sort((a, b) => b.p - a.p);
      table = repTable(['Loss Reason', 'Quotes', 'Premium Lost'], rows.map((r) => [r.r, r.c, 'BWP ' + fmt.money(r.p, true)]));
    } else {
      const hv = m.open.filter(data.isHighValue).sort((a, b) => b.premium - a.premium).slice(0, 10);
      table = repTable(['Client', 'Broker', 'Product', 'Premium', 'Stage'], hv.map((q) => [q.client, q.broker || 'Direct', q.cover, 'BWP ' + fmt.money(q.premium, true), data.stageLabel(q.stage)]));
    }

    openModal(`
      <div class="mh"><div><h3>${titles[key] || 'Report'}</h3><div class="ms">Print-ready · save as PDF</div></div>
        <div class="row" style="gap:8px;"><button class="btn primary sm" id="rpPrint">${ui.icon('download', 15)} Print / Save PDF</button><button class="icon-btn" id="rpClose">${ui.icon('x', 18)}</button></div></div>
      <div class="mb">
        <div class="report-sheet" id="reportSheet">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0e3536;padding-bottom:14px;">
            <div><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#0f8a7d;font-weight:700;">The Brittany · QuoteIQ</div><h2 style="margin:4px 0 0;">${titles[key]}</h2><div style="color:#5b6b75;font-size:13px;">Period: 1 Jun 2024 – 31 May 2025 · Generated 31 May 2025</div></div>
            <div style="text-align:right;color:#5b6b75;font-size:12px;">Prepared for<br><b style="color:#1c2b33;">Head of Sales & ExCo</b></div>
          </div>
          ${body}
          <h3 style="color:#0e3536;margin:6px 0 8px;">${key === 'loss' ? 'Lost premium by reason' : (key === 'broker' || key === 'rm') ? 'Performance ranking' : 'High-value open opportunities'}</h3>
          ${table}
          <p style="color:#8b98a1;font-size:11px;margin-top:24px;border-top:1px solid #e6eaee;padding-top:10px;">All amounts in BWP. Confidential — for internal management use. © 2025 The Brittany.</p>
        </div>
      </div>
    `, 'lg');
    document.getElementById('rpClose').onclick = closeModal;
    document.getElementById('rpPrint').onclick = () => {
      document.body.classList.add('printing-report');
      const after = () => { document.body.classList.remove('printing-report'); window.removeEventListener('afterprint', after); };
      window.addEventListener('afterprint', after);
      window.print();
    };
  };
  function repTable(head, rows) {
    return `<table style="width:100%;border-collapse:collapse;font-size:12.5px;">
      <thead><tr>${head.map((h, i) => `<th style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 10px;border-bottom:1px solid #d6dce2;color:#5b6b75;font-size:11px;text-transform:uppercase;">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'};padding:8px 10px;border-bottom:1px solid #eef1f4;${i === 0 ? 'font-weight:600;color:#1c2b33;' : ''}">${ui.esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  /* ---------- WELCOME TOUR ---------- */
  const TOUR = [
    { t: 'Welcome to QuoteIQ', d: 'A quotation intelligence control tower for The Brittany — built to show what was quoted, what converted, what was lost and why, and where to act. This is a clickable prototype with realistic Botswana sample data.' },
    { t: 'Capture → Workflow → Control tower', d: 'Use “+ New Quote” to capture a request, then open any quote to advance it through the lifecycle (assigned → prepared → sent → follow-up → won/lost). Everything you do updates the dashboards live.' },
    { t: 'Seven dashboards', d: 'Overview, Pipeline & Conversion, Brokers, RM Performance, Loss Analysis, Alerts and Reports — each turning operational quote data into management decisions.' },
    { t: 'Make it yours', d: 'The options panel (top-right gear) switches theme (light / dark / slate), accent and density, and lets you view as different personas — Head of Sales, RM, Underwriter, ExCo (read-only) or Admin. Reset demo data anytime.' },
  ];
  QIQ.forms.tour = function () {
    let i = 0;
    const render = () => {
      const s = TOUR[i];
      const m = document.querySelector('#modal-host .modal') ? document.querySelector('#modal-host .modal') : openModal('', 'tour');
      m.innerHTML = `
        <div class="mb" style="padding:26px 26px 8px;">
          <div class="step-img">${ui.brandMark(58)}</div>
          <h3 style="font-size:19px;">${s.t}</h3>
          <p class="muted" style="font-size:13.5px;line-height:1.55;margin-top:8px;">${s.d}</p>
        </div>
        <div class="mf" style="justify-content:space-between;align-items:center;">
          <div class="tour-dots">${TOUR.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
          <div class="row" style="gap:8px;">
            <button class="btn ghost" id="tourSkip">${i === TOUR.length - 1 ? 'Close' : 'Skip'}</button>
            ${i < TOUR.length - 1 ? `<button class="btn primary" id="tourNext">Next</button>` : `<button class="btn primary" id="tourDone">Explore QuoteIQ</button>`}
          </div>
        </div>`;
      const fin = () => { localStorage.setItem('qiq_seen_tour', '1'); closeModal(); };
      m.querySelector('#tourSkip').onclick = fin;
      const nx = m.querySelector('#tourNext'); if (nx) nx.onclick = () => { i++; render(); };
      const dn = m.querySelector('#tourDone'); if (dn) dn.onclick = fin;
    };
    render();
  };
})();
