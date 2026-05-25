/* ============================================================
   QuoteIQ — charts (Apache ECharts, themed from CSS variables)
   ============================================================ */
(function () {
  const QIQ = (window.QIQ = window.QIQ || {});
  const instances = [];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function theme() {
    return {
      text: cssVar('--text'), text2: cssVar('--text-2'), text3: cssVar('--text-3'),
      grid: cssVar('--chart-grid'), axis: cssVar('--chart-axis'),
      surface: cssVar('--surface'), surface2: cssVar('--surface-2'), border: cssVar('--border'),
      accent: cssVar('--accent'), accentStrong: cssVar('--accent-strong'),
      good: cssVar('--good'), warn: cssVar('--warn'), bad: cssVar('--bad'), info: cssVar('--info'), purple: cssVar('--purple'),
      // categorical palette (Motor, Property, Engineering, Marine, Group Life, + extras)
      palette: ['#15324a', '#18a999', '#34b56a', '#7a6cf0', '#e8973a', '#4a86d6', '#d9594f', '#b07cd6', '#56c2c9'],
    };
  }
  function tooltipBase(t) {
    return {
      backgroundColor: t.surface, borderColor: t.border, borderWidth: 1,
      textStyle: { color: t.text, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.16);padding:9px 12px;',
    };
  }

  function create(el, builder) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return null;
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    const t = theme();
    inst.setOption(builder(t), true);
    instances.push(inst);
    return inst;
  }
  function disposeAll() { while (instances.length) { try { instances.pop().dispose(); } catch (e) {} } }
  function resizeAll() { instances.forEach((i) => { try { i.resize(); } catch (e) {} }); }

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resizeAll, 120); });

  /* ---------- chart builders (return ECharts option) ---------- */
  const B = {
    funnel(rows) { // rows: [{name,value,pct}]
      return (t) => ({
        tooltip: Object.assign({ trigger: 'item', formatter: (p) => `${p.name}<br/><b>${p.value.toLocaleString()}</b> &nbsp; ${p.data.pct}` }, tooltipBase(t)),
        series: [{
          type: 'funnel', left: 8, right: 8, top: 6, bottom: 6, minSize: '24%', maxSize: '100%',
          sort: 'descending', gap: 3,
          label: { position: 'inside', color: '#fff', fontWeight: 600, fontSize: 12,
            formatter: (p) => `${p.name}` },
          labelLine: { show: false },
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          data: rows.map((r, i) => ({
            name: r.name, value: r.value, pct: r.pct,
            itemStyle: { color: r.color || echarts.color.modifyHSL(t.accent, null, null, 0.62 - i * 0.06) },
          })),
        }],
      });
    },

    donutRing(rows) { // rows:[{name,value,color}] — legend rendered in HTML
      return (t) => ({
        tooltip: Object.assign({ trigger: 'item', formatter: (p) => `${p.name}<br/><b>${p.value.toLocaleString()}</b> (${p.percent}%)` }, tooltipBase(t)),
        series: [{
          type: 'pie', radius: ['62%', '86%'], center: ['50%', '50%'], avoidLabelOverlap: false,
          label: { show: false }, labelLine: { show: false },
          itemStyle: { borderColor: t.surface, borderWidth: 3, borderRadius: 3 },
          data: rows.map((r, i) => ({ name: r.name, value: r.value, itemStyle: { color: r.color || t.palette[i % t.palette.length] } })),
        }],
      });
    },

    rankedBars(rows, opts) { // rows:[{name,value,label}] horizontal
      opts = opts || {};
      return (t) => ({
        grid: { left: 4, right: opts.right || 86, top: 6, bottom: 6, containLabel: true },
        tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'none' }, formatter: (p) => `${p[0].name}<br/><b>${opts.fmt ? opts.fmt(p[0].value) : p[0].value.toLocaleString()}</b>` }, tooltipBase(t)),
        xAxis: { type: 'value', show: false, max: opts.max },
        yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.name),
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: t.text2, fontSize: 12.5, fontWeight: 550, margin: 12 } },
        series: [{
          type: 'bar', barWidth: 14, data: rows.map((r) => r.value),
          itemStyle: { color: opts.color || t.accent, borderRadius: [0, 6, 6, 0] },
          label: { show: true, position: 'right', color: t.text, fontWeight: 600, fontSize: 12,
            formatter: (p) => rows[p.dataIndex].label != null ? rows[p.dataIndex].label : (opts.fmt ? opts.fmt(p.value) : p.value.toLocaleString()) },
        }],
      });
    },

    barsWithTarget(rows, target, opts) { // horizontal bars with a target line
      opts = opts || {};
      return (t) => ({
        grid: { left: 4, right: 44, top: 10, bottom: 28, containLabel: true },
        tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p) => `${p[0].name}<br/><b>${p[0].value} days</b>` }, tooltipBase(t)),
        xAxis: { type: 'value', max: opts.max || 6, axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.text3, fontSize: 11 } },
        yAxis: { type: 'category', inverse: true, data: rows.map((r) => r.name),
          axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text2, fontSize: 12, fontWeight: 550 } },
        series: [{
          type: 'bar', barWidth: 16, data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.value > target ? t.warn : t.accent, borderRadius: [0, 6, 6, 0] } })),
          label: { show: true, position: 'right', color: t.text, fontWeight: 600, fontSize: 12, formatter: (p) => p.value },
          markLine: { silent: true, symbol: 'none', lineStyle: { color: t.good, type: 'dashed', width: 2 },
            label: { formatter: 'SLA Target: ' + target + ' Days', color: t.good, fontSize: 11, fontWeight: 600, position: 'end' },
            data: [{ xAxis: target }] },
        }],
      });
    },

    stacked(months, series) { // series:[{name,data[],color}]
      return (t) => ({
        legend: { top: 0, left: 0, itemWidth: 11, itemHeight: 11, itemGap: 14, textStyle: { color: t.text2, fontSize: 12 }, icon: 'roundRect' },
        grid: { left: 6, right: 10, top: 42, bottom: 4, containLabel: true },
        tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => ps[0].axisValue + '<br/>' + ps.map((p) => `${p.marker} ${p.seriesName}: <b>BWP ${QIQ.fmt.money(p.value, true)}</b>`).join('<br/>') }, tooltipBase(t)),
        xAxis: { type: 'category', data: months, axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false }, axisLabel: { color: t.text3, fontSize: 11 } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.text3, fontSize: 11, formatter: (v) => 'BWP ' + QIQ.fmt.money(v, true) } },
        series: series.map((s, i) => ({
          name: s.name, type: 'bar', stack: 'v', barWidth: '52%',
          data: s.data, itemStyle: { color: s.color || t.palette[i % t.palette.length] },
          emphasis: { focus: 'series' },
        })),
      });
    },

    trend(weeks, won, lost) {
      return (t) => ({
        legend: { top: 0, right: 0, itemWidth: 18, itemGap: 16, textStyle: { color: t.text2, fontSize: 12 } },
        grid: { left: 6, right: 10, top: 36, bottom: 4, containLabel: true },
        tooltip: Object.assign({ trigger: 'axis',
          formatter: (ps) => ps[0].axisValue + '<br/>' + ps.map((p) => `${p.marker} ${p.seriesName}: <b>BWP ${QIQ.fmt.money(p.value, true)}</b>`).join('<br/>') }, tooltipBase(t)),
        xAxis: { type: 'category', boundaryGap: false, data: weeks, axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false }, axisLabel: { color: t.text3, fontSize: 11 } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.text3, fontSize: 11, formatter: (v) => QIQ.fmt.money(v, true) } },
        series: [
          { name: 'Won Premium (BWP)', type: 'line', smooth: true, data: won, symbol: 'circle', symbolSize: 7,
            lineStyle: { color: t.accent, width: 3 }, itemStyle: { color: t.accent },
            areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: echarts.color.modifyAlpha(t.accent, 0.22) }, { offset: 1, color: echarts.color.modifyAlpha(t.accent, 0.0) }]) } },
          { name: 'Lost Premium (BWP)', type: 'line', smooth: true, data: lost, symbol: 'circle', symbolSize: 6,
            lineStyle: { color: t.purple, width: 2.5, type: 'dashed' }, itemStyle: { color: t.purple } },
        ],
      });
    },

    lineSingle(x, vals, opts) {
      opts = opts || {};
      return (t) => {
        const c = opts.color || t.bad;
        return {
          grid: { left: 6, right: 12, top: 14, bottom: 4, containLabel: true },
          tooltip: Object.assign({ trigger: 'axis', formatter: (ps) => ps[0].axisValue + '<br/><b>BWP ' + QIQ.fmt.money(ps[0].value, true) + '</b>' }, tooltipBase(t)),
          xAxis: { type: 'category', boundaryGap: false, data: x, axisLine: { lineStyle: { color: t.grid } }, axisTick: { show: false }, axisLabel: { color: t.text3, fontSize: 11 } },
          yAxis: { type: 'value', splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.text3, fontSize: 11, formatter: (v) => QIQ.fmt.money(v, true) } },
          series: [{ type: 'line', smooth: true, data: vals, symbol: 'circle', symbolSize: 7,
            lineStyle: { color: c, width: 3 }, itemStyle: { color: c },
            areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: echarts.color.modifyAlpha(c, 0.22) }, { offset: 1, color: echarts.color.modifyAlpha(c, 0) }]) } }],
        };
      };
    },

    heatmap(rowsLabels, colLabels, data, maxv) { // data:[[x,y,val]]
      return (t) => ({
        grid: { left: 6, right: 10, top: 6, bottom: 26, containLabel: true },
        tooltip: Object.assign({ position: 'top', formatter: (p) => `${rowsLabels[p.value[1]]} · ${colLabels[p.value[0]]}<br/><b>${p.value[2]}</b> quotes` }, tooltipBase(t)),
        xAxis: { type: 'category', data: colLabels, splitArea: { show: true }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text3, fontSize: 10.5 } },
        yAxis: { type: 'category', data: rowsLabels, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.text2, fontSize: 11.5, fontWeight: 550 } },
        visualMap: { show: false, min: 0, max: maxv, inRange: { color: [t.surface2, echarts.color.modifyAlpha(t.accent, 0.5), t.warn, t.bad] } },
        series: [{ type: 'heatmap', data, label: { show: true, color: t.text, fontSize: 11, formatter: (p) => p.value[2] || '' },
          itemStyle: { borderColor: t.surface, borderWidth: 3, borderRadius: 4 }, emphasis: { itemStyle: { shadowBlur: 6 } } }],
      });
    },

    scatter(points) { // points:[{name,x,y,quad}] x=volume y=conversion
      const quadColor = (t) => ({ hh: t.good, hl: t.warn, lh: t.info, ll: t.bad });
      const maxX = Math.max.apply(null, points.map((p) => p.x));
      return (t) => {
        const qc = quadColor(t);
        return {
          grid: { left: 8, right: 22, top: 14, bottom: 42, containLabel: true },
          tooltip: Object.assign({ formatter: (p) => `<b>${p.data.name}</b><br/>Volume: ${p.data.value[0]}<br/>Conversion: ${(p.data.value[1]).toFixed(1)}%` }, tooltipBase(t)),
          xAxis: { name: 'Quote Volume', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: t.text3, fontSize: 11 },
            type: 'value', min: 0, max: Math.ceil(maxX * 1.12), splitLine: { lineStyle: { color: t.grid } }, axisLine: { show: false }, axisLabel: { color: t.text3, fontSize: 10 } },
          yAxis: { name: 'Conversion %', nameLocation: 'middle', nameGap: 34, nameTextStyle: { color: t.text3, fontSize: 11 },
            type: 'value', min: 0, max: 60, splitLine: { lineStyle: { color: t.grid } }, axisLine: { show: false }, axisLabel: { color: t.text3, fontSize: 10, formatter: '{value}%' } },
          series: [{
            type: 'scatter', symbolSize: (v) => Math.max(13, Math.min(34, Math.sqrt(v[2]) * 2.2)),
            data: points.map((p) => ({ name: p.name, value: [p.x, p.y, p.size], itemStyle: { color: qc[p.quad], opacity: 0.8, borderColor: t.surface, borderWidth: 1.5 } })),
            label: { show: true, position: 'top', color: t.text2, fontSize: 10, formatter: (p) => p.data.name, distance: 4 },
            labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' },
            markLine: { silent: true, symbol: 'none', lineStyle: { color: t.border, type: 'dashed' },
              data: [{ xAxis: points.midX }, { yAxis: 30 }] },
          }],
        };
      };
    },
  };

  QIQ.charts = { create, disposeAll, resizeAll, theme, B };
})();
