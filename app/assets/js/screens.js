/* ============================================================
   QuoteIQ — screens (dashboards + pipeline)
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});
  const { ui, data, fmt } = QIQ;
  const S = (QIQ.screens = {});

  /* ---------- shared compute ---------- */
  const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const getQuotes = () => data.filter(QIQ.app.scopedCtx().filters);

  function metrics(qs) {
    const open = qs.filter(data.isOpen);
    const won = qs.filter((q) => q.status === 'won');
    const lost = qs.filter((q) => q.status === 'lost');
    const decided = won.length + lost.length;
    const atRisk = qs.filter(data.isAtRisk);
    const reached = (i) => qs.filter((q) => q.reachedIdx >= i).length;
    return {
      total: qs.length, open, won, lost, decided,
      openPremium: data.sum(open, (q) => q.premium),
      quotedPremium: data.sum(qs, (q) => q.premium),
      wonPremium: data.sum(won, (q) => q.boundPremium || q.premium),
      lostPremium: data.sum(lost, (q) => q.premium),
      conversion: decided ? won.length / decided : 0,
      quoteToProposal: qs.length ? reached(3) / qs.length : 0,
      proposalToWin: reached(3) ? won.length / reached(3) : 0,
      avgTurnaround: avg(qs.map(data.turnaround).filter((x) => x != null)),
      avgAge: avg(open.map(data.age)),
      atRisk, atRiskCount: atRisk.length,
      atRiskPremium: data.sum(atRisk, (q) => q.premium),
      stalled: qs.filter(data.isStalled).length,
      overdue: qs.filter(data.isOverdue).length,
      expiring: qs.filter(data.isExpiring).length,
      slaBreaches: open.filter(data.isUWOverSLA).length,
      reached,
    };
  }

  function wonMTD(qs) {
    return data.sum(qs.filter((q) => q.status === 'won' && q.decisionDate && new Date(q.decisionDate).getMonth() === 4 && new Date(q.decisionDate).getFullYear() === 2025), (q) => q.boundPremium || q.premium);
  }
  function wonYTD(qs) {
    return data.sum(qs.filter((q) => q.status === 'won' && q.decisionDate && new Date(q.decisionDate).getFullYear() === 2025), (q) => q.boundPremium || q.premium);
  }

  function funnelRows(m) {
    return [
      { name: 'New Quote', value: m.total, pct: '100%' },
      { name: 'Under Review', value: m.reached(1), pct: pctOf(m.reached(1), m.total) },
      { name: 'Pricing', value: m.reached(2), pct: pctOf(m.reached(2), m.total) },
      { name: 'Proposal Sent', value: m.reached(3), pct: pctOf(m.reached(3), m.total) },
      { name: 'Negotiation', value: m.reached(4), pct: pctOf(m.reached(4), m.total) },
      { name: 'Won', value: m.won.length, pct: pctOf(m.won.length, m.total) },
    ];
  }
  const pctOf = (a, b) => b ? Math.round((a / b) * 100) + '%' : '0%';

  function agingBuckets(open) {
    const b = [
      { name: '0 – 3 days', lo: 0, hi: 3, color: '#18a999' },
      { name: '4 – 7 days', lo: 4, hi: 7, color: '#15324a' },
      { name: '8 – 14 days', lo: 8, hi: 14, color: '#e8973a' },
      { name: '15+ days', lo: 15, hi: 9999, color: '#7a6cf0' },
    ];
    return b.map((x) => Object.assign({ value: open.filter((q) => { const a = data.age(q); return a >= x.lo && a <= x.hi; }).length }, x));
  }

  function weeklyTrend(qs) {
    const weeks = []; const won = []; const lost = [];
    for (let i = 7; i >= 0; i--) {
      const end = fmt.addDays(fmt.TODAY, -i * 7);
      const start = fmt.addDays(end, -7);
      weeks.push(end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
      won.push(data.sum(qs.filter((q) => q.status === 'won' && q.decisionDate && q.decisionDate > +start && q.decisionDate <= +end), (q) => q.boundPremium || q.premium));
      lost.push(data.sum(qs.filter((q) => q.status === 'lost' && q.decisionDate && q.decisionDate > +start && q.decisionDate <= +end), (q) => q.premium));
    }
    return { weeks, won, lost };
  }

  function nextAction(q) {
    if (q.flags.includes('awaiting_uw')) return 'Chase underwriting';
    if (q.flags.includes('awaiting_client')) return 'Gather client info';
    if (q.flags.includes('awaiting_broker')) return 'Broker feedback call';
    if (q.flags.includes('escalated')) return 'Executive review';
    if (q.stage === 'pricing') return 'Provide revised terms';
    if (q.stage === 'proposal') return 'Client feedback call';
    if (q.stage === 'negotiation') return 'Close negotiation';
    if (q.stage === 'new') return 'Assign & acknowledge';
    return 'Follow up';
  }

  function brokerStats() {
    return data.BROKERS.map((b) => {
      const qs = data.quotes.filter((q) => q.broker === b.name);
      const won = qs.filter((q) => q.status === 'won');
      const lost = qs.filter((q) => q.status === 'lost');
      const dec = won.length + lost.length;
      const lossCounts = {};
      lost.forEach((q) => { lossCounts[q.lossReason] = (lossCounts[q.lossReason] || 0) + 1; });
      const topLoss = Object.entries(lossCounts).sort((a, c) => c[1] - a[1])[0];
      return {
        name: b.name, tier: b.tier, branch: b.branch, contact: b.contact,
        volume: qs.length, won: won.length, conversion: dec ? won.length / dec : 0,
        wonPremium: data.sum(won, (q) => q.boundPremium || q.premium),
        avgTurnaround: avg(qs.map(data.turnaround).filter((x) => x != null)),
        overdue: qs.filter(data.isOverdue).length,
        topLoss: topLoss ? topLoss[0] : '—',
      };
    });
  }
  function rmStats() {
    return data.RMS.map((r) => {
      const qs = data.quotes.filter((q) => q.rm === r.name);
      const won = qs.filter((q) => q.status === 'won');
      const lost = qs.filter((q) => q.status === 'lost');
      const dec = won.length + lost.length;
      return {
        name: r.name, team: r.team, head: !!r.head,
        volume: qs.length, won: won.length, conversion: dec ? won.length / dec : 0,
        wonPremium: data.sum(won, (q) => q.boundPremium || q.premium),
        avgTurnaround: avg(qs.map(data.turnaround).filter((x) => x != null)),
        overdue: qs.filter(data.isOverdue).length,
      };
    });
  }

  /* ============================================================
     1. OVERVIEW
     ============================================================ */
  S.overview = function () {
    const qs = getQuotes();
    const m = metrics(qs);
    const open = m.open;
    const aging = agingBuckets(open);
    const fr = funnelRows(m);
    const trend = weeklyTrend(qs);
    const hv = open.filter(data.isHighValue).sort((a, b) => b.premium - a.premium).slice(0, 5);

    const html = `
      ${QIQ.app.filterBar()}
      <div class="kpis">
        ${ui.kpi({ icon: 'file', label: 'Total Quotes', value: m.total.toLocaleString(), delta: { dir: 'up', text: '14%', good: true } })}
        ${ui.kpi({ icon: 'layers', label: 'Open Pipeline Premium', cur: 'BWP', value: fmt.money(m.openPremium, true), delta: { dir: 'up', text: '9%', good: true } })}
        ${ui.kpi({ icon: 'trophy', label: 'Won Premium MTD', cur: 'BWP', value: fmt.money(wonMTD(qs), true), delta: { dir: 'up', text: '21%', good: true } })}
        ${ui.kpi({ icon: 'target', label: 'Conversion Rate', value: fmt.pct(m.conversion), delta: { dir: 'up', text: '3.6pp', good: true } })}
        ${ui.kpi({ icon: 'clock', label: 'Avg Turnaround', value: m.avgTurnaround.toFixed(1) + ' days', delta: { dir: 'down', text: '0.6 days', good: true } })}
        ${ui.kpi({ icon: 'alert', label: 'Quotes at Risk', value: m.atRiskCount.toLocaleString(), delta: { dir: 'up', text: '15', good: false } })}
      </div>

      <div class="grid c3a">
        <div class="card">
          ${ui.cardHead('Pipeline by Stage', 'Quotes reaching each stage')}
          <div class="chart" id="ov-funnel" style="height:300px;"></div>
          ${ui.cardLink('View full pipeline', 'pipeline')}
        </div>
        <div class="card">
          ${ui.cardHead('Open Quotes Aging', null, { menu: true })}
          <div class="row" style="gap:16px;align-items:center;">
            <div class="chart" id="ov-aging" style="height:170px;width:170px;flex:none;position:relative;">
              <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none;">
                <div><div style="font-size:26px;font-weight:760;line-height:1;">${m.open.length}</div><div class="muted" style="font-size:11px;">Open Quotes</div></div>
              </div>
            </div>
            <div style="flex:1;">${ui.legendList(aging.map((a) => ({ name: a.name, value: a.value, color: a.color })))}</div>
          </div>
          ${ui.cardLink('View aging report', 'pipeline')}
        </div>
        <div class="card">
          ${ui.cardHead('Won vs Lost Trend', null, { menu: true })}
          <div class="chart" id="ov-trend" style="height:240px;"></div>
          ${ui.cardLink('View trend analysis', 'loss')}
        </div>
      </div>

      <div class="grid c12 mt">
        <div class="card">
          ${ui.cardHead('High-Value Opportunities', 'Open quotes above BWP ' + fmt.money(data.HIGH_VALUE, true))}
          <div class="table-wrap">
            <table class="tbl responsive">
              <thead><tr><th>Client</th><th>Broker</th><th>Product</th><th class="num">Premium (BWP)</th><th>Stage</th><th>Next Action</th></tr></thead>
              <tbody>
                ${hv.map((q) => `<tr class="clickable" data-quote="${q.id}">
                  <td data-label="Client" class="t-strong">${ui.esc(q.client)}</td>
                  <td data-label="Broker">${ui.esc(q.broker || 'Direct')}</td>
                  <td data-label="Product">${ui.esc(q.cover)}</td>
                  <td data-label="Premium" class="num money">${fmt.money(q.premium)}</td>
                  <td data-label="Stage">${ui.stageChip(q.stage)}</td>
                  <td data-label="Next Action"><div class="t-strong" style="font-weight:600;">${nextAction(q)}</div><div class="t-sub">${q.nextFollowUp ? fmt.date(q.nextFollowUp) : '—'}</div></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${ui.cardLink('View all opportunities', 'pipeline')}
        </div>
        <div class="card">
          ${ui.cardHead('Requires Attention')}
          <div class="action-list">
            ${attentionRow('flame', 'r', 'Stalled Quotes', 'No activity in 7+ days', m.stalled)}
            ${attentionRow('clock', 'a', 'Overdue Follow-ups', 'Past next action date', m.overdue)}
            ${attentionRow('alert', 'a', 'Expiring Quotes', 'Expiring in 7 days or less', m.expiring)}
          </div>
          ${ui.cardLink('Go to alerts center', 'alerts')}
        </div>
      </div>`;

    return {
      title: 'Executive Overview', sub: 'QuoteIQ control tower',
      html,
      mount() {
        const C = QIQ.charts;
        C.create('ov-funnel', C.B.rankedBars(fr.map((r) => ({ name: r.name, value: r.value, label: r.value.toLocaleString() + '  ·  ' + r.pct })), { color: QIQ.charts.theme().accent }));
        C.create('ov-aging', C.B.donutRing(aging.map((a) => ({ name: a.name, value: a.value, color: a.color }))));
        C.create('ov-trend', C.B.trend(trend.weeks, trend.won, trend.lost));
      },
    };
  };

  function attentionRow(ic, tone, title, sub, val) {
    return `<div class="action-row" data-go="alerts">
      <div class="ai ${tone}">${ui.icon(ic, 19)}</div>
      <div><div class="at">${title}</div><div class="ad">${sub}</div></div>
      <div class="av ${tone === 'r' ? 'r' : 'a'}">${val}</div>
      <div class="arr">${ui.icon('chevronRight', 18)}</div>
    </div>`;
  }

  /* ============================================================
     2. PIPELINE (Quotes tab + Conversion tab)
     ============================================================ */
  S.pipeline = function () {
    const tab = QIQ.state.pipelineTab;
    const tabs = `<div class="tabs">
      <button class="tab ${tab === 'quotes' ? 'active' : ''}" data-tab="quotes">Quotes</button>
      <button class="tab ${tab === 'conversion' ? 'active' : ''}" data-tab="conversion">Conversion</button>
    </div>`;
    return tab === 'conversion' ? pipelineConversion(tabs) : pipelineQuotes(tabs);
  };

  function pipelineQuotes(tabs) {
    const qs = getQuotes().slice().sort((a, b) => b.premium - a.premium);
    const shown = qs.slice(0, 80);
    const m = metrics(qs);
    const rowStrings = shown.map((q) => `<tr class="clickable" data-quote="${q.id}">
                <td data-label="Quote"><span class="t-strong">${q.id}</span></td>
                <td data-label="Client"><div class="t-strong">${ui.esc(q.client)}</div><div class="t-sub">${ui.esc(q.segment)} · ${ui.esc(q.region)}</div></td>
                <td data-label="Broker">${ui.esc(q.broker || 'Direct')}</td>
                <td data-label="RM">${ui.esc(q.rm)}</td>
                <td data-label="Product"><div>${ui.esc(q.line)}</div><div class="t-sub">${ui.esc(q.cover)}</div></td>
                <td data-label="Premium" class="num money">${fmt.money(q.premium)}</td>
                <td data-label="Stage">${ui.stageChip(q.stage)} ${(q.flags || []).slice(0, 1).map(ui.flagChip).join('')}</td>
                <td data-label="Age" class="num">${q.status === 'open' ? ui.ageCell(data.age(q)) : '<span class="muted">closed</span>'}</td>
                <td data-label="Next Follow-up">${q.status === 'open' && q.nextFollowUp ? (data.isOverdue(q) ? '<span class="age-hot">' + fmt.date(q.nextFollowUp) + '</span>' : fmt.date(q.nextFollowUp)) : '<span class="muted">—</span>'}</td>
              </tr>`);
    const more = tableMore(rowStrings);
    const html = `
      ${QIQ.app.filterBar({ status: true })}
      ${tabs}
      <div class="row wrap between" style="margin-bottom:12px;">
        <div class="row wrap" style="gap:18px;">
          <span class="muted">Showing <b style="color:var(--text);">${shown.length}</b> of <b style="color:var(--text);">${qs.length.toLocaleString()}</b> quotes</span>
          <span class="badge-soft">${m.open.length} open</span>
          <span class="badge-soft">Open premium: BWP ${fmt.money(m.openPremium, true)}</span>
        </div>
      </div>
      <div class="card" style="padding:6px 6px 2px;">
        <div class="table-wrap">
          <table class="tbl responsive">
            <thead><tr>
              <th>Quote</th><th>Client</th><th>Broker</th><th>RM</th><th>Product</th>
              <th class="num">Premium (BWP)</th><th>Stage</th><th class="num">Age</th><th>Next Follow-up</th>
            </tr></thead>
            <tbody>${more.body}</tbody>
          </table>
        </div>
        ${more.bar}
      </div>
      ${qs.length > shown.length ? `<p class="muted mt" style="text-align:center;">Showing top 80 by premium · use filters or export to see the full book.</p>` : ''}`;
    return { title: 'Pipeline & Conversion', sub: 'Working pipeline', html, mount(root) { wireShowMore(root); } };
  }

  function pipelineConversion(tabs) {
    const qs = getQuotes();
    const m = metrics(qs);
    const fr = funnelRows(m);
    const months = lastMonths(5);
    const lines = ['Motor', 'Property', 'Engineering', 'Marine', 'Group Life'];
    const series = lines.map((ln) => ({ name: ln, data: months.map((mo) => data.sum(qs.filter((q) => q.line === ln && inMonth(q.dateReceived, mo)), (q) => q.premium)) }));
    const src = sourceBreakdown(qs);
    const heat = agingByStage(qs);
    const atRisk = m.atRisk.slice().sort((a, b) => b.premium - a.premium).slice(0, 5);

    const html = `
      ${QIQ.app.filterBar()}
      ${tabs}
      <div class="kpis">
        ${ui.kpi({ icon: 'file', label: 'New Quotes', value: m.total.toLocaleString(), delta: { dir: 'up', text: '14%', good: true } })}
        ${ui.kpi({ icon: 'layers', label: 'Open Pipeline Value', cur: 'BWP', value: fmt.money(m.openPremium, true), delta: { dir: 'up', text: '9%', good: true } })}
        ${ui.kpi({ icon: 'target', label: 'Quote-to-Proposal', value: fmt.pct(m.quoteToProposal), delta: { dir: 'up', text: '3.6pp', good: true } })}
        ${ui.kpi({ icon: 'trophy', label: 'Proposal-to-Win', value: fmt.pct(m.proposalToWin), delta: { dir: 'up', text: '2.4pp', good: true } })}
        ${ui.kpi({ icon: 'clock', label: 'Avg Quote Age', value: m.avgAge.toFixed(1) + ' days', delta: { dir: 'down', text: '0.8 days', good: true } })}
        ${ui.kpi({ icon: 'alert', label: 'SLA Breaches', value: m.slaBreaches.toLocaleString(), delta: { dir: 'up', text: '12', good: false } })}
      </div>

      <div class="grid c3a">
        <div class="card">
          ${ui.cardHead('Pipeline Stage Conversion')}
          <div class="chart" id="pl-funnel" style="height:300px;"></div>
          ${ui.cardLink('View full conversion report', 'reports')}
        </div>
        <div class="card">
          ${ui.cardHead('Pipeline by Product Line', 'Quoted premium', { menu: true })}
          <div class="chart" id="pl-stacked" style="height:300px;"></div>
          ${ui.cardLink('View product line breakdown', 'loss')}
        </div>
        <div class="card">
          ${ui.cardHead('Quote Volume by Source')}
          <div class="row" style="gap:14px;align-items:center;">
            <div class="chart" id="pl-source" style="height:160px;width:160px;flex:none;position:relative;">
              <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;pointer-events:none;"><div><div style="font-size:23px;font-weight:760;line-height:1;">${m.total.toLocaleString()}</div><div class="muted" style="font-size:10.5px;">Total Quotes</div></div></div>
            </div>
            <div style="flex:1;min-width:0;">${ui.legendList(src.map((s) => ({ name: s.name, value: s.value, color: s.color, pct: s.pct })))}</div>
          </div>
          ${ui.cardLink('View source performance', 'brokers')}
        </div>
      </div>

      <div class="grid c12 mt">
        <div class="card">
          ${ui.cardHead('Aging by Stage', 'Number of open quotes')}
          <div class="chart" id="pl-heat" style="height:280px;"></div>
          ${ui.cardLink('View aging analysis', 'alerts')}
        </div>
        <div class="card">
          ${ui.cardHead('Immediate Actions')}
          <div class="action-list">
            ${attentionRow('flame', 'r', 'Stalled Quotes', 'No activity in 7+ days', m.stalled)}
            ${attentionRow('clock', 'a', 'Overdue Follow-ups', 'Past next action date', m.overdue)}
            ${attentionRow('zap', 'p', 'Escalated', 'High-value & stalled', qs.filter((q) => (q.flags || []).includes('escalated')).length)}
            ${attentionRow('alert', 'o', 'SLA Breaches', 'Underwriting beyond SLA', m.slaBreaches)}
          </div>
          ${ui.cardLink('Go to alerts center', 'alerts')}
        </div>
      </div>

      <div class="card mt">
        ${ui.cardHead('At-Risk Pipeline', 'Highest premium at risk')}
        <div class="table-wrap">
          <table class="tbl responsive">
            <thead><tr><th>Client</th><th>Broker</th><th class="num">Premium (BWP)</th><th>Stage</th><th class="num">Age</th><th>Owner</th><th>Risk Reason</th></tr></thead>
            <tbody>
              ${atRisk.map((q) => `<tr class="clickable" data-quote="${q.id}">
                <td data-label="Client" class="t-strong">${ui.esc(q.client)}</td>
                <td data-label="Broker">${ui.esc(q.broker || 'Direct')}</td>
                <td data-label="Premium" class="num money">${fmt.money(q.premium)}</td>
                <td data-label="Stage">${ui.stageChip(q.stage)}</td>
                <td data-label="Age" class="num">${ui.ageCell(data.age(q))}</td>
                <td data-label="Owner">${ui.esc(q.rm)}</td>
                <td data-label="Risk Reason">${riskReason(q)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${ui.cardLink('View full at-risk pipeline', 'alerts')}
      </div>`;

    return {
      title: 'Pipeline & Conversion', sub: 'Conversion analytics', html,
      mount() {
        const C = QIQ.charts, t = C.theme();
        C.create('pl-funnel', C.B.funnel(fr));
        C.create('pl-stacked', C.B.stacked(months.map(monthLabel), series.map((s, i) => Object.assign(s, { color: t.palette[i] }))));
        C.create('pl-source', C.B.donutRing(src.map((s) => ({ name: s.name, value: s.value, color: s.color }))));
        const heatData = []; heat.rows.forEach((r, y) => heat.cols.forEach((c, x) => heatData.push([x, y, heat.matrix[y][x]])));
        C.create('pl-heat', C.B.heatmap(heat.rows, heat.cols, heatData, heat.max));
      },
    };
  }

  function riskReason(q) {
    if (q.flags.includes('expired')) return ui.chip('Quote expired', 'tone-bad');
    if (q.flags.includes('awaiting_uw')) return ui.chip('Awaiting underwriter', 'tone-info');
    if (q.flags.includes('awaiting_client')) return ui.chip('Awaiting client info', 'tone-warn');
    if (q.flags.includes('awaiting_broker')) return ui.chip('Broker feedback pending', 'tone-warn');
    if (data.isOverdue(q)) return ui.chip('Follow-up overdue', 'tone-warn');
    if (data.isStalled(q)) return ui.chip('Stalled ' + data.daysSinceActivity(q) + 'd', 'tone-bad');
    return ui.chip('Monitor', 'tone-muted');
  }

  function sourceBreakdown(qs) {
    const palette = ['#18a999', '#15324a', '#34b56a', '#7a6cf0', '#e8973a', '#9aa7b1'];
    const counts = {};
    qs.forEach((q) => { const k = q.broker || 'Direct'; counts[k] = (counts[k] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5);
    const other = sorted.slice(5).reduce((s, x) => s + x[1], 0);
    const total = qs.length || 1;
    const rows = top.map(([name, value], i) => ({ name, value, color: palette[i], pct: Math.round(value / total * 100) }));
    if (other) rows.push({ name: 'Other Brokers', value: other, color: palette[5], pct: Math.round(other / total * 100) });
    return rows;
  }

  function agingByStage(qs) {
    const cols = ['0–3', '4–7', '8–14', '15–30', '31–60', '60+'];
    const stages = ['new', 'review', 'pricing', 'proposal', 'negotiation'];
    const rows = stages.map((s) => data.STAGES[s].label);
    const bucket = (a) => a <= 3 ? 0 : a <= 7 ? 1 : a <= 14 ? 2 : a <= 30 ? 3 : a <= 60 ? 4 : 5;
    const matrix = stages.map(() => [0, 0, 0, 0, 0, 0]);
    let max = 1;
    qs.filter(data.isOpen).forEach((q) => { const si = stages.indexOf(q.stage); if (si < 0) return; const bi = bucket(data.age(q)); matrix[si][bi]++; if (matrix[si][bi] > max) max = matrix[si][bi]; });
    return { cols, rows, matrix, max };
  }

  /* ============================================================
     3. BROKERS
     ============================================================ */
  S.brokers = function () {
    const all = data.quotes;
    const stats = brokerStats().sort((a, b) => b.volume - a.volume);
    const withBroker = all.filter((q) => q.broker);
    const won = withBroker.filter((q) => q.status === 'won');
    const dec = won.length + withBroker.filter((q) => q.status === 'lost').length;
    const topVol = stats.slice(0, 6);
    const midX = stats.map((s) => s.volume).sort((a, b) => a - b)[Math.floor(stats.length / 2)] || 50;
    const points = stats.map((s) => ({ name: s.name, x: s.volume, y: s.conversion * 100, size: Math.max(s.wonPremium / 1e5, 6), quad: (s.volume >= midX ? 'h' : 'l') + (s.conversion * 100 >= 30 ? 'h' : 'l') }));
    points.midX = midX;

    const html = `
      ${QIQ.app.filterBar()}
      <div class="kpis">
        ${ui.kpi({ icon: 'brokers', label: 'Active Brokers', value: data.BROKERS.length, delta: { dir: 'up', text: '2', good: true } })}
        ${ui.kpi({ icon: 'file', label: 'Broker Quotes', value: withBroker.length.toLocaleString(), delta: { dir: 'up', text: '11%', good: true } })}
        ${ui.kpi({ icon: 'target', label: 'Broker Conversion', value: fmt.pct(dec ? won.length / dec : 0), delta: { dir: 'up', text: '1.4pp', good: true } })}
        ${ui.kpi({ icon: 'trophy', label: 'Won via Brokers', cur: 'BWP', value: fmt.money(data.sum(won, (q) => q.boundPremium || q.premium), true), delta: { dir: 'up', text: '18%', good: true } })}
        ${ui.kpi({ icon: 'clock', label: 'Avg Turnaround', value: avg(withBroker.map(data.turnaround).filter((x) => x != null)).toFixed(1) + ' days', delta: { dir: 'down', text: '0.3 days', good: true } })}
        ${ui.kpi({ icon: 'alert', label: 'Overdue Follow-ups', value: withBroker.filter(data.isOverdue).length, delta: { dir: 'down', text: '6', good: true } })}
      </div>

      <div class="grid c21">
        <div class="card">
          ${ui.cardHead('Top Brokers / Partners', 'By quote volume')}
          ${ui.rankList(topVol.map((s) => ({ name: s.name, value: s.volume, valLabel: s.volume.toLocaleString(), sec: fmt.pct(s.conversion, 1) })), { secLabel: 'Conversion' })}
        </div>
        <div class="card">
          ${ui.cardHead('Broker Performance Matrix', 'Volume vs conversion · bubble = won premium')}
          <div class="row wrap" style="gap:6px 14px;margin-bottom:6px;font-size:11px;">
            ${legendDot('var(--good)', 'High vol · High conv')} ${legendDot('var(--warn)', 'High vol · Low conv')}
            ${legendDot('var(--info)', 'Low vol · High conv')} ${legendDot('var(--bad)', 'Low vol · Low conv')}
          </div>
          <div class="chart" id="br-matrix" style="height:250px;"></div>
        </div>
      </div>

      <div class="card mt">
        ${ui.cardHead('Broker Performance', 'All partners ranked by volume')}
        <div class="table-wrap">
          <table class="tbl responsive">
            <thead><tr><th>Broker</th><th>Tier</th><th>Branch</th><th class="num">Quotes</th><th class="num">Conversion</th><th class="num">Won Premium</th><th class="num">Avg TAT</th><th class="num">Overdue</th><th>Top Loss Reason</th></tr></thead>
            <tbody>
              ${stats.map((s) => `<tr>
                <td data-label="Broker"><div class="t-strong">${ui.esc(s.name)}</div><div class="t-sub">${ui.esc(s.contact)}</div></td>
                <td data-label="Tier">${ui.chip(s.tier, s.tier === 'Tier 1' ? 'tone-good' : s.tier === 'Tier 2' ? 'tone-info' : 'tone-muted')}</td>
                <td data-label="Branch">${ui.esc(s.branch)}</td>
                <td data-label="Quotes" class="num">${s.volume.toLocaleString()}</td>
                <td data-label="Conversion" class="num"><b style="color:${s.conversion >= 0.3 ? 'var(--good)' : s.conversion >= 0.2 ? 'var(--text)' : 'var(--bad)'}">${fmt.pct(s.conversion)}</b></td>
                <td data-label="Won Premium" class="num money">BWP ${fmt.money(s.wonPremium, true)}</td>
                <td data-label="Avg TAT" class="num">${s.avgTurnaround.toFixed(1)}d</td>
                <td data-label="Overdue" class="num">${s.overdue}</td>
                <td data-label="Top Loss Reason">${ui.esc(s.topLoss)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    return {
      title: 'Broker & Partner Performance', sub: 'Partner analytics', html,
      mount() {
        QIQ.charts.create('br-matrix', QIQ.charts.B.scatter(points));
      },
    };
  };
  function legendDot(c, label) { return `<span class="row" style="gap:6px;"><span style="width:9px;height:9px;border-radius:50%;background:${c};display:inline-block;"></span>${label}</span>`; }

  /* ============================================================
     4. RM PERFORMANCE
     ============================================================ */
  S.rm = function () {
    const all = data.quotes;
    const rms = rmStats().sort((a, b) => b.wonPremium - a.wonPremium);
    const bstats = brokerStats().sort((a, b) => b.volume - a.volume).slice(0, 5);
    const teamTat = data.TEAMS.map((tm) => ({ name: tm, value: +avg(all.filter((q) => q.team === tm).map(data.turnaround).filter((x) => x != null)).toFixed(1) }));
    const won = all.filter((q) => q.status === 'won');
    const dec = won.length + all.filter((q) => q.status === 'lost').length;
    const overdueTotal = all.filter(data.isOverdue).length;
    const followCompliance = 1 - (overdueTotal / Math.max(1, all.filter((q) => q.status === 'open' && q.nextFollowUp).length));

    // matrix reused
    const bstatsAll = brokerStats();
    const midX = bstatsAll.map((s) => s.volume).sort((a, b) => a - b)[Math.floor(bstatsAll.length / 2)] || 50;
    const points = bstatsAll.map((s) => ({ name: s.name, x: s.volume, y: s.conversion * 100, size: Math.max(s.wonPremium / 1e5, 6), quad: (s.volume >= midX ? 'h' : 'l') + (s.conversion * 100 >= 30 ? 'h' : 'l') }));
    points.midX = midX;

    const watch = buildWatchlist(rms, bstatsAll);

    const html = `
      ${QIQ.app.filterBar()}
      <div class="kpis">
        ${ui.kpi({ icon: 'rm', label: 'Active RMs', value: data.RMS.length, delta: { dir: 'flat', text: '0', good: true } })}
        ${ui.kpi({ icon: 'brokers', label: 'Active Brokers', value: data.BROKERS.length, delta: { dir: 'up', text: '2', good: true } })}
        ${ui.kpi({ icon: 'trophy', label: 'Won Premium YTD', cur: 'BWP', value: fmt.money(wonYTD(all), true), delta: { dir: 'up', text: '8%', good: true } })}
        ${ui.kpi({ icon: 'target', label: 'RM Conversion', value: fmt.pct(dec ? won.length / dec : 0), delta: { dir: 'up', text: '21%', good: true } })}
        ${ui.kpi({ icon: 'userCheck', label: 'Broker Conversion', value: fmt.pct(0.287), delta: { dir: 'up', text: '11%', good: true } })}
        ${ui.kpi({ icon: 'checkCircle', label: 'Follow-up Compliance', value: fmt.pct(followCompliance, 0), delta: { dir: 'up', text: '4pp', good: true } })}
      </div>

      <div class="grid c21">
        <div class="card">
          ${ui.cardHead('Top Relationship Managers', 'By won premium')}
          ${ui.rankList(rms.slice(0, 6).map((r) => ({ name: r.name + (r.head ? ' ★' : ''), value: r.wonPremium, valLabel: 'BWP ' + fmt.money(r.wonPremium, true), sec: fmt.pct(r.conversion, 1) })), { secLabel: 'Conversion' })}
          ${ui.cardLink('View all RMs', 'rm')}
        </div>
        <div class="card">
          ${ui.cardHead('Top Brokers / Partners', 'By quote volume')}
          ${ui.rankList(bstats.map((s) => ({ name: s.name, value: s.volume, valLabel: s.volume.toLocaleString(), sec: fmt.pct(s.conversion, 1) })), { secLabel: 'Conversion' })}
          ${ui.cardLink('View all brokers', 'brokers')}
        </div>
      </div>

      <div class="grid c3b mt">
        <div class="card">
          ${ui.cardHead('Turnaround (SLA) by Team', 'Avg turnaround (days)')}
          <div class="chart" id="rm-tat" style="height:240px;"></div>
        </div>
        <div class="card">
          ${ui.cardHead('Performance Watchlist')}
          <div class="table-wrap">
            <table class="tbl responsive">
              <thead><tr><th>Name</th><th class="num">Quotes</th><th class="num">Conversion</th><th class="num">Avg TAT</th><th class="num">Overdue</th><th>Suggested Action</th></tr></thead>
              <tbody>
                ${watch.map((w) => `<tr>
                  <td data-label="Name"><div class="t-strong">${ui.esc(w.name)}</div><div class="t-sub">${ui.esc(w.kind)}</div></td>
                  <td data-label="Quotes" class="num">${w.volume.toLocaleString()}</td>
                  <td data-label="Conversion" class="num">${fmt.pct(w.conversion)}</td>
                  <td data-label="Avg TAT" class="num">${w.avgTurnaround.toFixed(1)}d</td>
                  <td data-label="Overdue" class="num">${w.overdue}</td>
                  <td data-label="Suggested Action">${ui.chip(w.action, w.tone)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          ${ui.cardHead('Leadership Insights')}
          ${leadershipInsights(rms, bstatsAll, teamTat, followCompliance, all)}
          ${ui.cardLink('View all insights', 'loss')}
        </div>
      </div>`;

    return {
      title: 'RM & Broker Performance', sub: 'People & partners', html,
      mount() {
        QIQ.charts.create('rm-tat', QIQ.charts.B.barsWithTarget(teamTat, data.SLA_TARGET, { max: 6 }));
      },
    };
  };

  function buildWatchlist(rms, brokers) {
    const items = [];
    const bestB = brokers.slice().sort((a, b) => b.wonPremium - a.wonPremium)[0];
    const bestR = rms.slice().sort((a, b) => b.conversion - a.conversion)[0];
    const worstR = rms.slice().sort((a, b) => a.conversion - b.conversion)[0];
    const worstB = brokers.slice().sort((a, b) => a.conversion - b.conversion)[0];
    const midB = brokers.slice().sort((a, b) => b.volume - a.volume)[1];
    if (bestB) items.push(Object.assign({ kind: 'Broker', action: 'Maintain momentum', tone: 'tone-good' }, bestB));
    if (bestR) items.push(Object.assign({ kind: 'RM', action: 'Recognise & retain', tone: 'tone-good' }, bestR));
    if (midB) items.push(Object.assign({ kind: 'Broker', action: 'Deepen engagement', tone: 'tone-info' }, midB));
    if (worstR) items.push(Object.assign({ kind: 'RM', action: 'Coaching & support', tone: 'tone-warn' }, worstR));
    if (worstB) items.push(Object.assign({ kind: 'Broker', action: 'Evaluate & intervene', tone: 'tone-bad' }, worstB));
    return items;
  }

  function leadershipInsights(rms, brokers, teamTat, compliance, all) {
    const bestB = brokers.slice().sort((a, b) => b.wonPremium - a.wonPremium)[0];
    const worstR = rms.slice().sort((a, b) => a.conversion - b.conversion)[0];
    const slowTeam = teamTat.slice().sort((a, b) => b.value - a.value)[0];
    const belowHalf = brokers.filter((b) => b.conversion < 0.2).length;
    const oldHV = data.sum(all.filter((q) => q.status === 'open' && data.isHighValue(q) && data.age(q) > 15), (q) => q.premium);
    const rows = [
      { ic: 'trophy', tone: 'tone-good', t: 'Top performing broker', d: `${bestB.name} leads with BWP ${fmt.money(bestB.wonPremium, true)} won premium (+18% vs Apr 1–30)` },
      { ic: 'alert', tone: 'tone-warn', t: 'Underperforming RM', d: `${worstR.name} has the lowest conversion at ${fmt.pct(worstR.conversion)} and ${worstR.overdue} overdue follow-ups` },
      { ic: 'clock', tone: 'tone-info', t: 'Turnaround at risk', d: `${slowTeam.name} averaging ${slowTeam.value} days vs ${data.SLA_TARGET}-day SLA` },
      { ic: 'checkCircle', tone: 'tone-warn', t: 'Follow-up compliance', d: `${fmt.pct(compliance, 0)} overall compliance · ${belowHalf} brokers below 20%` },
      { ic: 'dollar', tone: 'tone-good', t: 'Largest premium opportunity', d: `BWP ${fmt.money(oldHV, true)} in active quotes aged > 15 days` },
    ];
    return rows.map((r) => `<div class="insight"><div class="ii ${r.tone}">${ui.icon(r.ic, 18)}</div><div><div class="it">${r.t}</div><div class="id">${ui.esc(r.d)}</div></div></div>`).join('');
  }

  /* ============================================================
     5. LOSS ANALYSIS
     ============================================================ */
  S.loss = function () {
    const qs = getQuotes();
    const lost = qs.filter((q) => q.status === 'lost');
    const byReason = data.LOSS_REASONS.map((r) => ({ name: r, value: data.sum(lost.filter((q) => q.lossReason === r), (q) => q.premium), count: lost.filter((q) => q.lossReason === r).length }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const months = lastMonths(6);
    const lossTrend = months.map((mo) => data.sum(lost.filter((q) => q.decisionDate && inMonth(q.decisionDate, mo)), (q) => q.premium));
    const byLine = data.LINES.map((ln) => ({ name: ln, value: data.sum(lost.filter((q) => q.line === ln), (q) => q.premium) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 6);
    const comp = competitorAnalysis(lost);
    const commentary = lost.filter((q) => q.lossComment).sort((a, b) => (b.decisionDate || 0) - (a.decisionDate || 0)).slice(0, 6);
    const totalLost = data.sum(lost, (q) => q.premium);

    const html = `
      ${QIQ.app.filterBar()}
      <div class="kpis">
        ${ui.kpi({ icon: 'loss', label: 'Lost Premium', cur: 'BWP', value: fmt.money(totalLost, true), delta: { dir: 'down', text: '7%', good: true } })}
        ${ui.kpi({ icon: 'file', label: 'Quotes Lost', value: lost.length.toLocaleString(), delta: { dir: 'down', text: '12', good: true } })}
        ${ui.kpi({ icon: 'alert', label: 'Top Loss Reason', value: byReason[0] ? byReason[0].name : '—' })}
        ${ui.kpi({ icon: 'dollar', label: 'Avg Price Gap', value: fmt.pct(comp.avgGap, 0), delta: { dir: 'down', text: '2pp', good: true } })}
        ${ui.kpi({ icon: 'brokers', label: 'Top Competitor', value: comp.top ? comp.top.name.split(' ')[0] : '—' })}
        ${ui.kpi({ icon: 'trendingUp', label: 'Win-back Potential', cur: 'BWP', value: fmt.money(totalLost * 0.18, true) })}
      </div>

      <div class="grid c21">
        <div class="card">
          ${ui.cardHead('Lost Premium by Reason')}
          <div class="chart" id="ls-reason" style="height:280px;"></div>
        </div>
        <div class="card">
          ${ui.cardHead('Lost Premium Trend', 'Last 6 months')}
          <div class="chart" id="ls-trend" style="height:280px;"></div>
        </div>
      </div>

      <div class="grid c21 mt">
        <div class="card">
          ${ui.cardHead('Lost Premium by Product Line')}
          <div class="chart" id="ls-line" style="height:250px;"></div>
        </div>
        <div class="card">
          ${ui.cardHead('Competitor Analysis', 'Where business is going')}
          <div class="table-wrap">
            <table class="tbl responsive">
              <thead><tr><th>Competitor</th><th class="num">Deals Lost</th><th class="num">Premium Lost</th><th class="num">Avg Price Gap</th></tr></thead>
              <tbody>
                ${comp.rows.map((c) => `<tr>
                  <td data-label="Competitor" class="t-strong">${ui.esc(c.name)}</td>
                  <td data-label="Deals Lost" class="num">${c.count}</td>
                  <td data-label="Premium Lost" class="num money">BWP ${fmt.money(c.premium, true)}</td>
                  <td data-label="Avg Price Gap" class="num">${c.gap ? fmt.pct(c.gap, 0) : '—'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card mt">
        ${ui.cardHead('Loss Commentary', 'Recent lost-business notes')}
        <div class="action-list">
          ${commentary.map((q) => `<div class="action-row clickable" data-quote="${q.id}" style="cursor:pointer;">
            <div class="ai r">${ui.icon('msg', 18)}</div>
            <div style="flex:1;min-width:0;"><div class="at">${ui.esc(q.client)} · <span class="muted" style="font-weight:500;">${ui.esc(q.cover)}</span></div><div class="ad">${ui.esc(q.lossComment)}</div></div>
            <div class="nowrap">${ui.chip(q.lossReason, 'tone-bad')}<div class="t-sub right" style="margin-top:4px;">BWP ${fmt.money(q.premium, true)}</div></div>
          </div>`).join('') || '<div class="empty">No loss commentary in range</div>'}
        </div>
      </div>`;

    return {
      title: 'Loss Analysis', sub: 'Lost-business intelligence', html,
      mount() {
        const C = QIQ.charts, t = C.theme();
        C.create('ls-reason', C.B.rankedBars(byReason.map((r) => ({ name: r.name, value: r.value, label: 'BWP ' + fmt.money(r.value, true) })), { color: t.bad }));
        C.create('ls-trend', C.B.lineSingle(months.map(monthLabel), lossTrend, { color: t.bad }));
        C.create('ls-line', C.B.rankedBars(byLine.map((r) => ({ name: r.name, value: r.value, label: 'BWP ' + fmt.money(r.value, true) })), { color: t.warn }));
      },
    };
  };

  function competitorAnalysis(lost) {
    const map = {};
    lost.forEach((q) => { if (!q.competitor) return; const c = map[q.competitor] || (map[q.competitor] = { name: q.competitor, count: 0, premium: 0, gaps: [] }); c.count++; c.premium += q.premium; if (q.competitorPremium) c.gaps.push((q.premium - q.competitorPremium) / q.premium); });
    const rows = Object.values(map).map((c) => ({ name: c.name, count: c.count, premium: c.premium, gap: c.gaps.length ? avg(c.gaps) : 0 })).sort((a, b) => b.premium - a.premium);
    const allGaps = rows.flatMap((r) => r.gap ? [r.gap] : []);
    return { rows: rows.slice(0, 7), top: rows[0], avgGap: avg(allGaps) };
  }

  /* ============================================================
     6. ALERTS / ESCALATION QUEUE
     ============================================================ */
  S.alerts = function () {
    const qs = getQuotes();
    const m = metrics(qs);
    const cat = QIQ.state.alertCat || 'all';
    const lists = {
      stalled: qs.filter(data.isStalled),
      overdue: qs.filter(data.isOverdue),
      expiring: qs.filter((q) => data.isExpiring(q) || data.isExpired(q)),
      sla: m.open.filter(data.isUWOverSLA),
      escalated: qs.filter((q) => (q.flags || []).includes('escalated')),
    };
    let rows;
    if (cat === 'all') { const seen = new Set(); rows = [].concat(lists.escalated, lists.stalled, lists.overdue, lists.expiring, lists.sla).filter((q) => { if (seen.has(q.id)) return false; seen.add(q.id); return true; }); }
    else rows = lists[cat] || [];
    rows = rows.slice().sort((a, b) => b.premium - a.premium).slice(0, 60);

    const pill = (k, label, n) => `<button class="${cat === k ? 'active' : ''}" data-cat="${k}">${label} <b>${n}</b></button>`;
    const rowStrings = rows.map((q) => `<tr class="clickable" data-quote="${q.id}">
                <td data-label="Quote" class="t-strong">${q.id}</td>
                <td data-label="Client"><div class="t-strong">${ui.esc(q.client)}</div><div class="t-sub">${ui.esc(q.cover)}</div></td>
                <td data-label="Broker">${ui.esc(q.broker || 'Direct')}</td>
                <td data-label="Premium" class="num money">${fmt.money(q.premium)}</td>
                <td data-label="Stage">${ui.stageChip(q.stage)}</td>
                <td data-label="Age" class="num">${ui.ageCell(data.age(q))}</td>
                <td data-label="Owner">${ui.esc(q.rm)}</td>
                <td data-label="Flags">${(q.flags || []).map(ui.flagChip).join(' ') || '—'}</td>
                <td data-label="Action"><span class="t-strong" style="color:var(--accent-strong);font-weight:600;">${nextAction(q)}</span></td>
              </tr>`);
    const more = tableMore(rowStrings);
    const emptyRow = '<tr><td colspan="9"><div class="empty">' + ui.icon('checkCircle', 40) + '<div>Nothing in this queue — pipeline is healthy.</div></div></td></tr>';

    const html = `
      ${QIQ.app.filterBar()}
      <div class="grid c5">
        ${alertCard('zap', 'p', 'Escalated', 'High-value & stalled', lists.escalated.length, 'escalated', cat)}
        ${alertCard('flame', 'r', 'Stalled', 'No activity 7+ days', lists.stalled.length, 'stalled', cat)}
        ${alertCard('clock', 'a', 'Overdue', 'Follow-up overdue', lists.overdue.length, 'overdue', cat)}
        ${alertCard('alert', 'a', 'Expiring', 'Within 7 days / expired', lists.expiring.length, 'expiring', cat)}
        ${alertCard('shield', 'o', 'SLA Breaches', 'UW beyond SLA', lists.sla.length, 'sla', cat)}
      </div>

      <div class="card mt">
        <div class="card-head">
          <div><div class="t">Escalation Queue</div><div class="s">Premium at risk: BWP ${fmt.money(data.sum(rows, (q) => q.premium), true)} · ${rows.length} quotes</div></div>
          <div class="pill-group" id="catPills">
            ${pill('all', 'All', lists.escalated.length + lists.stalled.length)}
            ${pill('escalated', 'Escalated', lists.escalated.length)}
            ${pill('overdue', 'Overdue', lists.overdue.length)}
            ${pill('expiring', 'Expiring', lists.expiring.length)}
            ${pill('sla', 'SLA', lists.sla.length)}
          </div>
        </div>
        <div class="table-wrap">
          <table class="tbl responsive">
            <thead><tr><th>Quote</th><th>Client</th><th>Broker</th><th class="num">Premium at Risk</th><th>Stage</th><th class="num">Age</th><th>Owner</th><th>Flags</th><th>Action</th></tr></thead>
            <tbody>${rows.length ? more.body : emptyRow}</tbody>
          </table>
        </div>
        ${rows.length ? more.bar : ''}
      </div>`;

    return {
      title: 'Alerts & Escalation', sub: 'Where to intervene', html,
      mount(root) {
        root.querySelectorAll('#catPills button').forEach((b) => b.onclick = () => { QIQ.state.alertCat = b.dataset.cat; QIQ.app.renderRoute(); });
        root.querySelectorAll('[data-alertgo]').forEach((b) => b.onclick = () => { QIQ.state.alertCat = b.dataset.alertgo; QIQ.app.renderRoute(); });
        wireShowMore(root);
      },
    };
  };
  function alertCard(ic, tone, title, sub, n, cat, active) {
    return `<div class="card" data-alertgo="${cat}" style="cursor:pointer;${active === cat ? 'border-color:var(--accent);' : ''}padding:16px;">
      <div class="row between"><div class="ai ${tone}" style="width:36px;height:36px;border-radius:10px;display:grid;place-items:center;">${ui.icon(ic, 18)}</div><div class="av ${tone === 'r' ? 'r' : tone === 'p' ? 'p' : 'a'}" style="font-size:26px;font-weight:760;">${n}</div></div>
      <div class="at" style="font-weight:650;margin-top:10px;">${title}</div><div class="ad muted" style="font-size:12px;">${sub}</div>
    </div>`;
  }

  /* ============================================================
     7. REPORTS
     ============================================================ */
  S.reports = function () {
    const reports = [
      { key: 'exec', ic: 'trophy', t: 'Executive Weekly Report', d: 'KPIs, pipeline health, premium at risk & wins for ExCo.' },
      { key: 'pipeline', ic: 'pipeline', t: 'Pipeline & Conversion', d: 'Stage conversion, aging and source mix.' },
      { key: 'broker', ic: 'brokers', t: 'Broker Performance', d: 'Volume, conversion, won premium and loss reasons by partner.' },
      { key: 'rm', ic: 'rm', t: 'RM Performance', d: 'Quotes handled, conversion, turnaround and follow-up discipline.' },
      { key: 'loss', ic: 'loss', t: 'Loss Analysis', d: 'Lost premium by reason, competitor and product line.' },
      { key: 'sla', ic: 'clock', t: 'SLA / Turnaround', d: 'Request-to-quote and underwriting SLA performance.' },
    ];
    const html = `
      <div class="row between wrap" style="margin-bottom:18px;">
        <div><p class="muted" style="margin:0;">Generate exports for weekly sales meetings and ExCo reporting. CSV exports and print-ready PDF views are produced from the live data.</p></div>
        <div class="row" style="gap:10px;"><span class="badge-soft">Cadence: Weekly · Mondays 08:00</span></div>
      </div>
      <div class="grid c3">
        ${reports.map((r) => `<div class="card">
          <div class="row" style="gap:12px;align-items:flex-start;margin-bottom:12px;">
            <div class="ic" style="width:40px;height:40px;border-radius:11px;background:var(--accent-soft);color:var(--accent-strong);display:grid;place-items:center;flex:none;">${ui.icon(r.ic, 20)}</div>
            <div><div class="t" style="font-weight:650;">${r.t}</div><div class="ad muted" style="font-size:12.5px;margin-top:3px;">${r.d}</div></div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="btn primary sm" data-report="${r.key}">${ui.icon('file', 15)} Open report</button>
            <button class="btn sm" data-csv="${r.key}">${ui.icon('download', 15)} CSV</button>
          </div>
        </div>`).join('')}
      </div>
      <div class="card mt">
        ${ui.cardHead('Scheduled & recent', 'Demo placeholder')}
        <div class="action-list">
          <div class="action-row"><div class="ai i">${ui.icon('mail', 18)}</div><div style="flex:1;"><div class="at">Executive Weekly — distributed to ExCo</div><div class="ad">Last sent Mon 26 May 2025 · 5 recipients</div></div>${ui.chip('Sent', 'tone-good')}</div>
          <div class="action-row"><div class="ai a">${ui.icon('clock', 18)}</div><div style="flex:1;"><div class="at">Broker Performance — month-end pack</div><div class="ad">Scheduled Fri 30 May 2025</div></div>${ui.chip('Scheduled', 'tone-info')}</div>
        </div>
      </div>`;

    return {
      title: 'Reports & Exports', sub: 'Weekly cadence', html,
      mount(root) {
        root.querySelectorAll('[data-report]').forEach((b) => b.onclick = () => QIQ.forms.openReport(b.dataset.report));
        root.querySelectorAll('[data-csv]').forEach((b) => b.onclick = () => { const qs = data.filter(QIQ.app.scopedCtx().filters); QIQ.app.exportCSV(qs, 'quoteiq-' + b.dataset.csv + '.csv'); ui.toast('Exported ' + qs.length + ' rows to CSV', 'good'); });
      },
    };
  };

  /* ---------- quote detail (delegates to forms.js) ---------- */
  S.quoteDetail = function (id) { return QIQ.forms.quoteDetail(id); };

  /* ---------- month helpers ---------- */
  function lastMonths(n) {
    const out = []; const base = new Date(2025, 4, 1);
    for (let i = n - 1; i >= 0; i--) out.push(new Date(base.getFullYear(), base.getMonth() - i, 1));
    return out;
  }
  function inMonth(ts, mo) { const d = new Date(ts); return d.getMonth() === mo.getMonth() && d.getFullYear() === mo.getFullYear(); }

  // Mobile-only row capping: full list on desktop, first 12 + "Show more" on small screens.
  function tableMore(rowStrings) {
    const mobile = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth <= 620 : false;
    const init = mobile ? 12 : rowStrings.length;
    if (rowStrings.length <= init) return { body: rowStrings.join(''), bar: '' };
    const vis = rowStrings.slice(0, init).join('');
    const hid = rowStrings.slice(init).map((r) => r.replace('<tr ', '<tr hidden data-more="1" ')).join('');
    const left = rowStrings.length - init;
    return { body: vis + hid, bar: `<div class="show-more-bar"><button class="btn" data-showmore>${ui.icon('chevronDown', 15)} Show more (${left} more)</button></div>` };
  }
  function wireShowMore(root) {
    const btn = root.querySelector('[data-showmore]'); if (!btn) return;
    btn.onclick = () => {
      const hidden = root.querySelectorAll('tr[data-more][hidden]');
      let n = 0; for (const tr of hidden) { if (n++ >= 12) break; tr.removeAttribute('hidden'); }
      const left = root.querySelectorAll('tr[data-more][hidden]').length;
      if (!left) { const bar = btn.closest('.show-more-bar'); if (bar) bar.remove(); }
      else btn.innerHTML = ui.icon('chevronDown', 15) + ' Show more (' + left + ' more)';
    };
  }
  QIQ._more = { tableMore, wireShowMore };
  function monthLabel(mo) { return mo.toLocaleDateString('en-GB', { month: 'short' }) + ' ' + String(mo.getFullYear()).slice(2); }

  QIQ._screenUtil = { metrics, getQuotes };
})();
