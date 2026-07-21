/* ============================================================
   QuoteIQ — data layer
   Seeded, reproducible Botswana insurance sample dataset.
   In-memory, persisted to localStorage. No backend.
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});

  const TODAY = new Date(2025, 4, 31); // 31 May 2025 (demo "today")
  const DAY = 86400000;

  /* ---------- seeded RNG (mulberry32) ---------- */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- reference data ---------- */
  const STAGE_ORDER = ['new', 'review', 'pricing', 'proposal', 'negotiation'];
  const STAGES = {
    new:        { label: 'New Quote',     cls: 'st-new' },
    review:     { label: 'Under Review',  cls: 'st-review' },
    pricing:    { label: 'Pricing',       cls: 'st-pricing' },
    proposal:   { label: 'Proposal Sent', cls: 'st-proposal' },
    negotiation:{ label: 'Negotiation',   cls: 'st-negotiation' },
    won:        { label: 'Won',           cls: 'st-won' },
    lost:       { label: 'Lost',          cls: 'st-lost' },
  };
  // The richer lifecycle states ride on top as flags (Q8 decision).
  const FLAGS = {
    awaiting_uw:     { label: 'Awaiting Underwriting', tone: 'tone-info' },
    awaiting_client: { label: 'Awaiting Client Info',  tone: 'tone-warn' },
    awaiting_broker: { label: 'Awaiting Broker Feedback', tone: 'tone-warn' },
    followup_due:    { label: 'Follow-Up Due',         tone: 'tone-warn' },
    escalated:       { label: 'Escalated',             tone: 'tone-bad' },
    expired:         { label: 'Expired',               tone: 'tone-bad' },
  };

  const LOSS_REASONS = ['Pricing', 'Incumbent retained', 'Tender outcome', 'Brand trust', 'Coverage gaps', 'Service concerns', 'Other'];
  const COMPETITORS = ['Botswana Insurance Co.', 'Hollard Botswana', 'Old Mutual', 'Sanlam', 'Metropolitan Life', 'Bryte', 'Regent', 'Alexander Forbes Insurance'];

  const PRODUCTS = {
    'Motor':       { covers: ['Commercial Fleet', 'Private Motor', 'Motor Trade'], base: 85000 },
    'Property':    { covers: ['Fire & Allied Perils', 'Householders', 'Business Interruption', 'Commercial Combined'], base: 280000 },
    'Engineering': { covers: ['Contractors All Risks', 'Machinery Breakdown', 'Electronic Equipment'], base: 620000 },
    'Marine':      { covers: ['Cargo Insurance', 'Marine Hull', 'Goods in Transit'], base: 410000 },
    'Liability':   { covers: ['Public Liability', 'Professional Indemnity', 'Directors & Officers'], base: 320000 },
    'Agriculture': { covers: ['Farmers All Risks', 'Crop Insurance', 'Livestock'], base: 450000 },
    'Group Life':  { covers: ['Group Life', 'Group Funeral'], base: 520000 },
    'Health':      { covers: ['Medical Aid Top-up', 'Group Health'], base: 360000 },
    'Funeral':     { covers: ['Family Funeral Plan'], base: 28000 },
  };
  const LINES = Object.keys(PRODUCTS);

  const CHANNELS = ['Broker', 'Direct', 'Email', 'WhatsApp', 'Tender/RFQ', 'Walk-in'];

  const TEAMS = ['Corporate & Commercial', 'Property & Engineering', 'Retail & SME', 'Specialty Risks', 'Agriculture'];

  const RMS = [
    { name: 'Kabelo Moroke',   team: 'Corporate & Commercial', skill: 1.18, w: 1.4 },
    { name: 'Neo Dlamini',     team: 'Property & Engineering', skill: 1.10, w: 1.3 },
    { name: 'Michael Ndlovu',  team: 'Corporate & Commercial', skill: 1.05, w: 1.2, head: true },
    { name: 'Thato Mokoena',   team: 'Specialty Risks',        skill: 0.82, w: 1.1 },
    { name: 'Lesedi Phiri',    team: 'Retail & SME',           skill: 0.98, w: 1.0 },
    { name: 'Boitumelo Rampa', team: 'Agriculture',            skill: 0.90, w: 0.9 },
    { name: 'Lorato Dlamini',  team: 'Property & Engineering', skill: 1.02, w: 0.9 },
    { name: 'Pako Kgosi',      team: 'Agriculture',            skill: 0.78, w: 0.8 },
  ];

  const BROKERS = [
    { name: 'Alpha Brokers',             tier: 'Tier 1', branch: 'Gaborone',    skill: 1.20, w: 2.4, contact: 'Onkarabile Sello' },
    { name: 'TradeSure Brokers',         tier: 'Tier 1', branch: 'Gaborone',    skill: 1.05, w: 2.1, contact: 'Refilwe Mabote' },
    { name: 'Premier Brokers',           tier: 'Tier 1', branch: 'Francistown', skill: 1.00, w: 1.6, contact: 'James Keatlholetswe' },
    { name: 'Botswana Marine Co.',       tier: 'Tier 2', branch: 'Gaborone',    skill: 1.12, w: 1.5, contact: 'Tshepo Garekwe' },
    { name: 'Minet Botswana',            tier: 'Tier 1', branch: 'Gaborone',    skill: 1.08, w: 1.5, contact: 'Amantle Phuthego' },
    { name: 'Aon Botswana',              tier: 'Tier 1', branch: 'Gaborone',    skill: 1.06, w: 1.4, contact: 'Gorata Tau' },
    { name: 'AgriPro Brokers',           tier: 'Tier 2', branch: 'Maun',        skill: 0.92, w: 1.1, contact: 'Kefilwe Ramotswa' },
    { name: 'Kalahari Insurance Brokers',tier: 'Tier 2', branch: 'Maun',        skill: 0.95, w: 1.0, contact: 'Mpho Tabona' },
    { name: 'Northern Agri Brokers',     tier: 'Tier 3', branch: 'Francistown', skill: 0.80, w: 0.8, contact: 'Bonang Selepe' },
    { name: 'Desert Risk Advisors',      tier: 'Tier 3', branch: 'Gaborone',    skill: 0.66, w: 0.7, contact: 'Thabang Dube' },
  ];

  const SEGMENTS = ['Corporate', 'Commercial', 'SME', 'Public Sector', 'Affluent', 'Retail'];
  const INDUSTRIES = ['Mining', 'Construction', 'Logistics', 'Retail', 'Government/Parastatal', 'Agriculture', 'Financial Services', 'Hospitality', 'Manufacturing', 'Energy'];
  const REGIONS = ['Gaborone', 'Francistown', 'Maun', 'Lobatse', 'Selebi-Phikwe', 'Palapye', 'Kasane'];

  const ROLES = {
    head:  { name: 'Michael Ndlovu',  role: 'Head of Sales',      initials: 'MN', readonly: false, landing: 'overview' },
    rm:    { name: 'Lesedi Phiri',    role: 'Relationship Manager', initials: 'LP', readonly: false, landing: 'pipeline', scope: 'rm' },
    uw:    { name: 'Naledi Setlhare', role: 'Underwriter',        initials: 'NS', readonly: false, landing: 'alerts', scope: 'uw' },
    exco:  { name: 'Andrew Kgosi',    role: 'ExCo Viewer',        initials: 'AK', readonly: true,  landing: 'overview' },
    admin: { name: 'Kwaku Mensah',    role: 'Administrator',      initials: 'KM', readonly: false, landing: 'overview' },
  };

  /* ---------- client pool ---------- */
  const C_PREFIX = ['Botswana', 'Kalahari', 'Okavango', 'Gaborone', 'Chobe', 'Tswana', 'Kgalagadi', 'Phakalane', 'Tlokweng', 'Naledi', 'Bosele', 'Maru', 'Limpopo', 'Selibe', 'Tati', 'Mahalapye', 'Serowe', 'Boteti'];
  const C_CORE = ['Mining', 'Logistics', 'Energy', 'Holdings', 'Trading', 'Farms', 'Properties', 'Construction', 'Foods', 'Retailers', 'Motors', 'Hospitality', 'Agro', 'Industries', 'Resources', 'Transport', 'Milling', 'Cement'];
  const C_SUFFIX = ['(Pty) Ltd', 'Group', 'Holdings', '(Pty) Ltd', '(Pty) Ltd', 'Ltd'];

  // hero clients seen in the screenshots — kept verbatim
  const HERO_CLIENTS = [
    { name: 'Botswana Mining Co.',     industry: 'Mining',        segment: 'Corporate',  region: 'Selebi-Phikwe', strategic: true,  existing: true },
    { name: 'SADC Logistics (Pty) Ltd',industry: 'Logistics',     segment: 'Corporate',  region: 'Gaborone',      strategic: true,  existing: true },
    { name: 'Kalahari Energy (Pty) Ltd',industry: 'Energy',       segment: 'Corporate',  region: 'Gaborone',      strategic: true,  existing: false },
    { name: 'BluePeak Hospitality',    industry: 'Hospitality',   segment: 'Commercial', region: 'Kasane',        strategic: false, existing: true },
    { name: 'Northern Agro (Pty) Ltd', industry: 'Agriculture',   segment: 'Commercial', region: 'Francistown',   strategic: false, existing: true },
    { name: 'Botswana Milling Co.',    industry: 'Manufacturing', segment: 'Corporate',  region: 'Palapye',       strategic: true,  existing: true },
  ];

  function buildClients(rand) {
    const list = HERO_CLIENTS.map((c) => Object.assign({ type: 'Corporate' }, c));
    const seen = new Set(list.map((c) => c.name));
    while (list.length < 140) {
      const name = `${pick(rand, C_PREFIX)} ${pick(rand, C_CORE)} ${pick(rand, C_SUFFIX)}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const seg = pick(rand, SEGMENTS);
      list.push({
        name,
        industry: pick(rand, INDUSTRIES),
        segment: seg,
        region: pick(rand, REGIONS),
        type: seg === 'SME' || seg === 'Retail' ? 'SME' : (seg === 'Affluent' ? 'Individual' : 'Corporate'),
        existing: rand() < 0.55,
        strategic: rand() < 0.12,
      });
    }
    return list;
  }

  /* ---------- helpers ---------- */
  function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
  function wpick(rand, arr, key) {
    const tot = arr.reduce((s, x) => s + (key ? x[key] : x.w), 0);
    let r = rand() * tot;
    for (const x of arr) { r -= (key ? x[key] : x.w); if (r <= 0) return x; }
    return arr[arr.length - 1];
  }
  function addDays(d, n) { return new Date(d.getTime() + n * DAY); }
  function daysBetween(a, b) { return Math.round((b - a) / DAY); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function smooth(rand, lo, hi) { return lo + (hi - lo) * rand(); }
  function lognormalFactor(rand) {
    // skewed multiplier: mostly 0.4–2x, occasional large outliers
    const u = rand(), v = rand();
    const g = Math.sqrt(-2 * Math.log(u || 1e-9)) * Math.cos(2 * Math.PI * v);
    return clamp(Math.exp(g * 0.7), 0.25, 18);
  }

  /* ---------- generation ---------- */
  function generate() {
    const rand = rng(20250531);
    const clients = buildClients(rand);
    const quotes = [];
    const N = 1248;
    const START = new Date(2024, 5, 1); // 1 Jun 2024

    for (let i = 0; i < N; i++) {
      // received date: strongly weighted toward recent weeks so the OPEN book stays young
      const ageDays = Math.floor(Math.pow(rand(), 2.1) * 330);
      const received = addDays(TODAY, -ageDays);

      const client = pick(rand, clients);
      const rm = wpick(rand, RMS);
      const channel = wpick(rand, [
        { v: 'Broker', w: 6 }, { v: 'Tender/RFQ', w: 1.4 }, { v: 'Direct', w: 1.6 },
        { v: 'Email', w: 1.4 }, { v: 'WhatsApp', w: 1.2 }, { v: 'Walk-in', w: 0.6 },
      ], 'w').v;
      const usesBroker = channel === 'Broker' || channel === 'Tender/RFQ' || rand() < 0.25;
      const broker = usesBroker ? wpick(rand, BROKERS) : null;

      const line = wpick(rand, LINES.map((l) => ({ l, w: PRODUCTS[l].base > 400000 ? 1.4 : 2.2 })), 'w').l;
      const cover = pick(rand, PRODUCTS[line].covers);
      const premium = Math.round((PRODUCTS[line].base * lognormalFactor(rand)) / 100) * 100;

      // turnaround timing
      const tAssign = Math.floor(smooth(rand, 0, 2));
      const tPrepare = 1 + Math.floor(smooth(rand, 0, 4) * (broker ? 1 : 0.7));
      const tSend = Math.floor(smooth(rand, 0, 2));
      const assigned = addDays(received, tAssign);
      const prepared = addDays(assigned, tPrepare);
      const sent = addDays(prepared, tSend);

      // outcome model
      const skill = (broker ? broker.skill : 1.0) * rm.skill;
      // older quotes are almost always resolved; anything past ~10 weeks is closed
      let pClosed = clamp((ageDays - 4) / 40, 0.02, 0.99);
      if (ageDays > 70) pClosed = 1;
      let status, stage, reachedIdx, decisionDate = null, boundPremium = null, lossReason = null, competitor = null, competitorPremium = null, lossComment = null;
      const flags = [];

      if (rand() < pClosed) {
        // decided
        const pWin = clamp(0.30 * skill, 0.12, 0.62);
        decisionDate = addDays(sent, 2 + Math.floor(smooth(rand, 0, 22)));
        if (decisionDate > TODAY) decisionDate = TODAY;
        if (rand() < pWin) {
          status = 'won'; stage = 'won'; reachedIdx = 5;
          boundPremium = Math.round(premium * smooth(rand, 0.92, 1.0));
        } else {
          status = 'lost'; stage = 'lost';
          reachedIdx = 1 + Math.floor(wpick(rand, [{ v: 1, w: 1 }, { v: 2, w: 2.5 }, { v: 3, w: 3 }, { v: 4, w: 2 }], 'w').v) - 1;
          lossReason = wpick(rand, [
            { v: 'Pricing', w: 3.2 }, { v: 'Incumbent retained', w: 2.2 }, { v: 'Tender outcome', w: 1.6 },
            { v: 'Brand trust', w: 1.0 }, { v: 'Coverage gaps', w: 1.3 }, { v: 'Service concerns', w: 1.0 }, { v: 'Other', w: 0.7 },
          ], 'w').v;
          if (lossReason === 'Pricing' || lossReason === 'Incumbent retained' || rand() < 0.4) {
            competitor = pick(rand, COMPETITORS);
            if (lossReason === 'Pricing') { competitorPremium = Math.round(premium * smooth(rand, 0.72, 0.95)); }
          }
          lossComment = lossReason === 'Pricing' ? 'Client cited premium ~' + Math.round(smooth(rand, 6, 22)) + '% above competing quote.'
            : lossReason === 'Incumbent retained' ? 'Incumbent insurer matched terms at renewal.'
            : lossReason === 'Tender outcome' ? 'Tender awarded to alternate panel member.'
            : '';
        }
      } else {
        // open
        status = 'open';
        // later stage more likely the older it is
        const bias = clamp(ageDays / 45, 0, 1);
        reachedIdx = Math.floor(clamp(rand() * (1.2 + bias * 4), 0, 4));
        stage = STAGE_ORDER[reachedIdx];
      }

      // follow-ups (only meaningful once sent / negotiating / decided-after-send)
      const followUps = [];
      let lastFollowUp = null, nextFollowUp = null, followUpCount = 0;
      const reachedSent = reachedIdx >= 3 || status !== 'open';
      if (reachedSent && sent <= TODAY) {
        const n = Math.floor(smooth(rand, 0, 5));
        let cur = addDays(sent, 2 + Math.floor(smooth(rand, 0, 3)));
        for (let k = 0; k < n && cur <= (decisionDate || TODAY); k++) {
          followUps.push({ date: cur.getTime(), by: rm.name, note: pick(rand, ['Called broker for update', 'Emailed revised terms', 'Client requested clarification on cover', 'Awaiting signed acceptance', 'Left voicemail with contact', 'Sent reminder ahead of expiry']) });
          lastFollowUp = cur; followUpCount++;
          cur = addDays(cur, 3 + Math.floor(smooth(rand, 0, 5)));
        }
        if (status === 'open') nextFollowUp = cur;
      }

      // underwriting
      let underwriter = null, uwAssigned = null, uwReturned = null, slaStatus = null;
      if (reachedIdx >= 2 || status !== 'open') {
        underwriter = pick(rand, ['Naledi Setlhare', 'Goitseone Marumo', 'Karabo Lesetedi']);
        uwAssigned = addDays(assigned, Math.floor(smooth(rand, 0, 2)));
        const uwDur = smooth(rand, 0.5, 5);
        if (reachedIdx >= 3 || status !== 'open') { uwReturned = addDays(uwAssigned, uwDur); }
        const dur = uwReturned ? daysBetween(uwAssigned, uwReturned) : daysBetween(uwAssigned, TODAY);
        slaStatus = dur > 2 ? 'breached' : 'within';
      }

      const validUntil = reachedSent ? addDays(sent, 30) : null;

      const q = {
        id: 'Q-2025-' + String(1000 + i).slice(-4),
        ref: 'BRT/' + (received.getFullYear()) + '/' + String(4000 + i),
        client: client.name,
        clientType: client.type, industry: client.industry, segment: client.segment,
        region: client.region, existing: client.existing, strategic: client.strategic,
        broker: broker ? broker.name : null,
        brokerTier: broker ? broker.tier : null,
        brokerBranch: broker ? broker.branch : null,
        brokerContact: broker ? broker.contact : null,
        rm: rm.name, team: rm.team,
        channel,
        line, cover,
        sumInsured: Math.round(premium * smooth(rand, 18, 60) / 1000) * 1000,
        premium,
        dateReceived: received.getTime(),
        dateAssigned: assigned.getTime(),
        datePrepared: reachedIdx >= 2 || status !== 'open' ? prepared.getTime() : null,
        dateSent: reachedSent ? sent.getTime() : null,
        validUntil: validUntil ? validUntil.getTime() : null,
        stage, status, reachedIdx,
        flags,
        followUps, lastFollowUp: lastFollowUp ? lastFollowUp.getTime() : null,
        nextFollowUp: nextFollowUp ? nextFollowUp.getTime() : null, followUpCount,
        underwriter, uwAssigned: uwAssigned ? uwAssigned.getTime() : null,
        uwReturned: uwReturned ? uwReturned.getTime() : null, slaStatus,
        decisionDate: decisionDate ? decisionDate.getTime() : null,
        boundPremium, lossReason, competitor, competitorPremium, lossComment,
        createdBy: rm.name, updatedAt: (decisionDate || lastFollowUp || sent || received).getTime(),
        notes: '',
      };

      // derive flags for open quotes
      if (status === 'open') {
        const age = D.age(q);
        if (D.isExpired(q)) flags.push('expired');
        if (stage === 'pricing' && rand() < 0.5) flags.push('awaiting_uw');
        if (stage === 'review' && rand() < 0.4) flags.push('awaiting_client');
        if ((stage === 'proposal' || stage === 'negotiation') && rand() < 0.4) flags.push('awaiting_broker');
        if (D.isOverdue(q)) flags.push('followup_due');
        if (D.isHighValue(q) && age > 14) flags.push('escalated');
      }

      quotes.push(q);
    }

    return quotes;
  }

  /* ---------- derivations ---------- */
  const D = {
    TODAY, DAY, STAGES, STAGE_ORDER, FLAGS, LOSS_REASONS, PRODUCTS, LINES, CHANNELS,
    TEAMS, RMS, BROKERS, SEGMENTS, INDUSTRIES, REGIONS, ROLES, COMPETITORS,
    HIGH_VALUE: 250000,        // escalation premium threshold
    SLA_TARGET: 3,             // request→quote days
    quotes: [],

    age(q) { return daysBetween(new Date(q.dateReceived), TODAY); },
    turnaround(q) { return q.dateSent ? daysBetween(new Date(q.dateReceived), new Date(q.dateSent)) : null; },
    decisionDays(q) { return q.dateSent && q.decisionDate ? daysBetween(new Date(q.dateSent), new Date(q.decisionDate)) : null; },
    uwDays(q) { return q.uwAssigned ? daysBetween(new Date(q.uwAssigned), q.uwReturned ? new Date(q.uwReturned) : TODAY) : null; },
    isOpen(q) { return q.status === 'open'; },
    isHighValue(q) { return q.premium >= D.HIGH_VALUE; },
    isExpired(q) { return q.status === 'open' && q.validUntil && new Date(q.validUntil) < TODAY; },
    isExpiring(q) { return q.status === 'open' && q.validUntil && !D.isExpired(q) && daysBetween(TODAY, new Date(q.validUntil)) <= 7; },
    isOverdue(q) { return q.status === 'open' && q.nextFollowUp && new Date(q.nextFollowUp) < TODAY; },
    isStalled(q) { return q.status === 'open' && D.daysSinceActivity(q) >= 7 && (q.reachedIdx >= 3 || D.isHighValue(q)); },
    daysSinceActivity(q) { return daysBetween(new Date(q.lastFollowUp || q.dateSent || q.dateReceived), TODAY); },
    isAtRisk(q) { return q.status === 'open' && (D.isStalled(q) || D.isOverdue(q) || D.isExpiring(q) || q.flags.includes('escalated')); },
    isUWOverSLA(q) { return q.slaStatus === 'breached' && q.status === 'open'; },

    stageLabel(s) { return (STAGES[s] || { label: s }).label; },

    byId(id) { return D.quotes.find((q) => q.id === id); },

    /* persistence */
    KEY: 'qiq_state_v2',
    load() {
      try {
        const raw = localStorage.getItem(D.KEY);
        if (raw) { const obj = JSON.parse(raw); if (obj && obj.quotes && obj.quotes.length) { D.quotes = obj.quotes; return; } }
      } catch (e) {}
      D.quotes = generate(); D.save();
    },
    save() { try { localStorage.setItem(D.KEY, JSON.stringify({ quotes: D.quotes, v: 1 })); } catch (e) {} },
    reset() { D.quotes = generate(); D.save(); },

    /* mutations */
    nextId() {
      let max = 1000;
      D.quotes.forEach((q) => { const n = parseInt(String(q.id).slice(-4), 10); if (n > max) max = n; });
      return 'Q-2025-' + String(max + 1).slice(-4);
    },
    addQuote(data) {
      const now = Date.now();
      const q = Object.assign({
        id: D.nextId(), ref: 'BRT/2025/' + Math.floor(5000 + Math.random() * 4000),
        stage: 'new', status: 'open', reachedIdx: 0, flags: [],
        followUps: [], lastFollowUp: null, nextFollowUp: addDays(TODAY, 2).getTime(), followUpCount: 0,
        dateReceived: now, dateAssigned: now, datePrepared: null, dateSent: null, validUntil: null,
        underwriter: null, uwAssigned: null, uwReturned: null, slaStatus: null,
        decisionDate: null, boundPremium: null, lossReason: null, competitor: null, competitorPremium: null, lossComment: '',
        createdBy: (QIQ.state && QIQ.state.user.name) || 'System', updatedAt: now, notes: '',
        history: [{ ts: now, action: 'Quote request captured', by: (QIQ.state && QIQ.state.user.name) || 'System' }],
      }, data);
      D.quotes.unshift(q); D.save(); return q;
    },
    advance(q) {
      const idx = STAGE_ORDER.indexOf(q.stage);
      if (idx < 0 || idx >= STAGE_ORDER.length - 1) return q;
      const next = STAGE_ORDER[idx + 1];
      const now = TODAY.getTime();
      q.stage = next; q.reachedIdx = Math.max(q.reachedIdx, idx + 1);
      if (next === 'pricing' && !q.datePrepared) q.datePrepared = now;
      if (next === 'proposal') { q.dateSent = q.dateSent || now; q.validUntil = q.validUntil || addDays(TODAY, 30).getTime(); }
      D._log(q, 'Advanced to ' + STAGES[next].label); D.save(); return q;
    },
    markWon(q) {
      q.status = 'won'; q.stage = 'won'; q.reachedIdx = 5;
      q.decisionDate = TODAY.getTime(); q.boundPremium = q.premium; q.nextFollowUp = null;
      D._log(q, 'Marked Won — premium bound'); D.save(); return q;
    },
    markLost(q, reason, competitor, compPremium, comment) {
      q.status = 'lost'; q.stage = 'lost';
      q.decisionDate = TODAY.getTime(); q.lossReason = reason; q.competitor = competitor || null;
      q.competitorPremium = compPremium || null; q.lossComment = comment || ''; q.nextFollowUp = null;
      D._log(q, 'Marked Lost — ' + reason); D.save(); return q;
    },
    logFollowUp(q, note) {
      const now = TODAY.getTime();
      q.followUps = q.followUps || [];
      q.followUps.push({ date: now, by: (QIQ.state && QIQ.state.user.name) || 'RM', note });
      q.lastFollowUp = now; q.followUpCount = (q.followUpCount || 0) + 1;
      q.nextFollowUp = addDays(TODAY, 3).getTime();
      q.flags = (q.flags || []).filter((f) => f !== 'followup_due');
      D._log(q, 'Follow-up logged'); D.save(); return q;
    },
    _log(q, action) {
      q.history = q.history || [];
      q.history.push({ ts: TODAY.getTime(), action, by: (QIQ.state && QIQ.state.user.name) || 'System' });
      q.updatedAt = Date.now();
    },

    /* querying */
    filter(f) {
      f = f || {};
      return D.quotes.filter((q) => {
        if (f.scopeRM && q.rm !== f.scopeRM) return false;
        if (f.line && f.line !== 'All' && q.line !== f.line) return false;
        if (f.broker && f.broker !== 'All' && q.broker !== f.broker) return false;
        if (f.rm && f.rm !== 'All' && q.rm !== f.rm) return false;
        if (f.region && f.region !== 'All' && q.region !== f.region) return false;
        if (f.status && f.status !== 'All' && q.status !== f.status) return false;
        if (f.stage && f.stage !== 'All' && q.stage !== f.stage) return false;
        if (f.channel && f.channel !== 'All' && q.channel !== f.channel) return false;
        if (f.month != null) { const d = new Date(q.dateReceived); if (d.getMonth() !== f.month.m || d.getFullYear() !== f.month.y) return false; }
        if (f.search) { const s = f.search.toLowerCase(); if (!((q.client + ' ' + (q.broker || '') + ' ' + q.rm + ' ' + q.id + ' ' + q.line + ' ' + q.cover).toLowerCase().includes(s))) return false; }
        return true;
      });
    },
    sum(arr, fn) { return arr.reduce((s, x) => s + (fn ? fn(x) : x), 0); },
    groupBy(arr, fn) { const m = new Map(); arr.forEach((x) => { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; },
  };

  QIQ.data = D;
  QIQ.fmt = {
    money(n, compact) {
      if (n == null) return '—';
      if (compact) {
        const a = Math.abs(n);
        if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (a >= 1e3) return (n / 1e3).toFixed(0) + 'k';
        return String(Math.round(n));
      }
      return n.toLocaleString('en-US');
    },
    bwp(n, compact) { return 'BWP ' + QIQ.fmt.money(n, compact); },
    pula(n, compact) { return 'P ' + QIQ.fmt.money(n, compact); },
    pct(n, d) { return (n * 100).toFixed(d == null ? 1 : d) + '%'; },
    date(ts) { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); },
    dateShort(ts) { if (!ts) return '—'; return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); },
    addDays, daysBetween, TODAY,
  };
})();
