(() => {
  'use strict';
  const D = JSON.parse(document.getElementById('aar-data').textContent);
  const en = D.language === 'en';
  const tr = (ko, english) => en ? english : ko;
  const h = (tag, parent, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    parent.append(n);
    return n;
  };
  const get = kind => D.sections.find(s => s.kind === kind);
  const fmt = n => Number(n).toLocaleString(en ? 'en-US' : 'ko-KR');
  const compact = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : fmt(n);
  const shortModel = name => name.replace(/^claude-/, '').replace(/-20\d{6}$/, '').replace(/^(opus|sonnet|haiku)/, s => s[0].toUpperCase() + s.slice(1));
  // SVG 글자 폭 추정(12px 기준): 한글 등 전각은 11.5px, 그 외는 6.6px. 주어진 폭을 넘으면 자른다.
  const charPx = ch => ch.charCodeAt(0) > 0x2e7f ? 11.5 : 6.6;
  const clipTo = (s, room) => {
    let used = 0;
    for (let i = 0; i < s.length; i++) {
      used += charPx(s[i]);
      if (used > room) return s.slice(0, Math.max(1, i - 1)) + '…';
    }
    return s;
  };
  // 서버의 ISO 오프셋으로 표시한다. 열람자의 로컬 시간대를 쓰지 않는다.
  const overview = get('overview').text;
  const offset = overview.match(/([+-])(\d{2}):(\d{2})(?:\s|$)/);
  const offsetMs = offset ? (offset[1] === '+' ? 1 : -1) * (+offset[2] * 60 + +offset[3]) * 60000 : 0;
  const time = at => new Date(at + offsetMs).toISOString().slice(11, 16);
  const dateTime = at => new Date(at + offsetMs).toISOString().slice(0, 16).replace('T', ' ');
  const main = h('main', document.body);
  const header = h('header', main);
  const heading = h('div', header);
  h('p', heading, tr('프로젝트 회고', 'Project review'), 'eyebrow');
  h('h1', heading, D.title);
  h('p', heading, `${dateTime(D.axis.t0)} ~ ${dateTime(D.axis.t1)} ${offset ? 'UTC' + offset[0].trim() : 'UTC'}`, 'meta');
  document.title = D.title + ' · AAR';
  const theme = h('button', h('div', header, undefined, 'header-actions'), tr('테마 전환', 'Toggle theme'));
  theme.type = 'button';
  const setTheme = value => { document.documentElement.dataset.theme = value; theme.setAttribute('aria-label', tr('테마 전환 · 현재 ', 'Toggle theme; current ') + value); };
  theme.onclick = () => {
    const current = document.documentElement.dataset.theme;
    const dark = current ? current === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(dark ? 'light' : 'dark');
  };
  const queryTheme = new URLSearchParams(location.search).get('theme');
  if (['dark', 'light'].includes(queryTheme)) setTheme(queryTheme);
  const hero = h('section', main, undefined, 'hero-grid');
  hero.setAttribute('aria-label', tr('핵심 수치', 'Key figures'));
  get('hero').cards.forEach(c => {
    const m = h('article', hero, undefined, 'metric');
    h('p', m, c.title, 'metric-label');
    const val = h('p', m, c.body, 'metric-value');
    if (c.badge) h('span', val, c.badge, 'unit');
    (c.evidence || []).forEach(t => h('div', m, t, 'note'));
  });
  const section = (title, subtitle, parent = main, panel = true) => {
    const s = h('section', parent, undefined, 'section' + (panel ? ' panel' : ''));
    const head = h('div', s, undefined, 'section-head');
    h('h2', head, title);
    if (subtitle) h('p', s, subtitle, 'note');
    return s;
  };
  const text = (parent, content) => (content || '').split('\n\n').filter(Boolean).forEach(p => h('p', parent, p));
  const review = section(tr('계획과 결과, 다음 실행', 'Plan, outcome, next action'), '', main, false);
  const reviewGrid = h('div', review, undefined, 'review-grid');
  const cards = get('review').cards;
  const improvements = get('improvements').cards || [];
  for (let i = 0; i < 4; i++) {
    const c = cards[i] || {title: [tr('계획','Plan'), tr('실제','Actual'), tr('차이','Gap'), tr('개선','Improvement')][i], body: tr('작성되지 않음', 'Not written')};
    const a = h('article', reviewGrid, undefined, 'review-card ' + ['plan', 'actual', 'gap', 'improve'][i]);
    h('h3', a, c.title);
    text(a, c.body);
    if (c.evidence?.length) h('p', a, c.evidence.join(' / '), 'evidence');
    if (i === 3 && improvements.length) {
      const grid = h('div', a, undefined, 'improvement-grid');
      improvements.forEach(item => {
        const imp = h('article', grid, undefined, 'improvement');
        h('h4', imp, item.title);
        h('p', imp, item.body, 'note');
        const actions = h('div', imp, undefined, 'prompt-actions');
        h('span', actions, tr('이 사항을 개선하려면', 'To apply this improvement'));
        const copy = h('button', actions, tr('적용 프롬프트 복사', 'Copy apply prompt'));
        copy.type = 'button';
        const details = h('details', imp, undefined, 'prompt');
        h('summary', details, tr('자기완결 프롬프트 보기', 'View self-contained prompt'));
        const pre = h('pre', details, item.prompt || '');
        const status = h('div', imp, '', 'status');
        status.setAttribute('role', 'status');
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(item.prompt);
            status.textContent = tr('복사했습니다.', 'Copied.');
          } catch (e) {
            details.open = true;
            const range = document.createRange();
            range.selectNodeContents(pre);
            const selection = getSelection();
            selection.removeAllRanges(); selection.addRange(range);
            status.textContent = tr('자동 복사를 사용할 수 없습니다. 선택된 내용을 복사하세요.', 'Automatic copy unavailable. Copy the selected text.');
          }
        };
      });
    }
  }
  const legend = (parent, entries) => {
    const box = h('div', parent, undefined, 'legend');
    entries.forEach(([label, color, opacity]) => {
      const item = h('span', box, undefined, 'legend-item');
      const sw = h('i', item, undefined, 'swatch');
      sw.style.background = `var(${color})`;
      if (opacity) sw.style.opacity = opacity;
      h('span', item, label);
    });
  };
  const modelEntries = [...new Map(get('models').chart.map(r => [r.label, [shortModel(r.label), r.color]])).values()];
  // viewBox는 컨테이너 폭에 맞춘다. 360px에서도 텍스트를 축소하지 않는다.
  // minWidth를 넘기면 좁은 화면에서 축소하지 않고 가로 스크롤한다(구조도처럼 열이 고정인 그림).
  const chart = (parent, label, draw, minWidth = 240) => {
    const scroll = minWidth > 240;
    const box = h('div', parent, undefined, 'chart' + (scroll ? ' scroll' : ''));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); box.append(svg);
    const el = (tag, attrs, content, target = svg) => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
      if (content !== undefined) n.textContent = content;
      target.append(n); return n;
    };
    let previousWidth = 0;
    const paint = () => {
      const width = Math.max(minWidth, Math.floor(box.clientWidth));
      if (width === previousWidth) return;
      previousWidth = width;
      svg.replaceChildren();
      const height = draw(el, width);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      if (scroll) svg.style.width = width + 'px';
    };
    paint();
    new ResizeObserver(paint).observe(box);
    return svg;
  };
  const grid = (el, axis, left, right, top, bottom, count = 4) => {
    for (let i = 0; i <= count; i++) {
      const x = left + (right - left) * i / count;
      el('line', {x1:x, x2:x, y1:top, y2:bottom, class:'grid-line'});
      el('text', {x, y:top - 9, class:'axis', 'text-anchor':i === 0 ? 'start' : i === count ? 'end' : 'middle'}, time(axis.t0 + (axis.t1 - axis.t0) * i / count));
    }
  };
  const map = get('delegation');
  const mapPanel = section(tr('위임 지도', 'Delegation map'), '');
  legend(mapPanel, [...modelEntries, [tr('Codex 외부 실행', 'External Codex runs'), '--ext']]);
  const mapRows = [...map.chart].sort((a,b) => {
    const order = key => { const n = Number((key || '').replace('S','')); return n || 99999; };
    return order(a.group) - order(b.group) || (a.role === 'session' ? -1 : b.role === 'session' ? 1 : a.start - b.start);
  });
  // 두 가지 보기: 구조도(세션에서 서브에이전트 · Codex로 이어지는 이전 AAR 방식)와 시간축 겹침. ?map=timeline 으로 시작 보기를 바꾼다.
  // 보기 전환 공통: 버튼 묶음과 보기별 상자. ?<param>=<key> 로 시작 보기를 바꾸고, 기본은 첫 보기.
  const viewToggle = (panel, label, views, param) => {
    const toggle = h('div', panel, undefined, 'view-toggle');
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', label);
    const boxes = {}, buttons = {};
    const show = key => views.forEach(([k]) => { boxes[k].hidden = k !== key; buttons[k].setAttribute('aria-pressed', String(k === key)); });
    views.forEach(([key, text]) => {
      const b = h('button', toggle, text);
      b.type = 'button';
      b.onclick = () => show(key);
      buttons[key] = b;
      boxes[key] = h('div', panel, undefined, 'view');
    });
    const wanted = new URLSearchParams(location.search).get(param);
    show(views.some(([k]) => k === wanted) ? wanted : views[0][0]);
    return boxes;
  };
  const boxes = viewToggle(mapPanel, tr('위임 지도 보기 방식', 'Delegation map view'), [['structure', tr('구조도', 'Structure')], ['timeline', tr('시간축 겹침', 'Time overlap')]], 'map');
  const minutes = r => { const m = (r.end - r.start) / 60000; return (m < 10 ? m.toFixed(1) : m.toFixed(0)) + tr('분', ' min'); };
  const detailOf = r => r.detail.split(' · ').map(shortModel).join(' · ');
  const trees = mapRows.filter(r => r.role === 'session').map(s => ({ s, kids: mapRows.filter(r => r.parent === s.label && r !== s) })).filter(t => t.kids.length);
  const idle = mapRows.filter(r => r.role === 'session' && !trees.some(t => t.s === r)).map(r => r.label);
  h('p', boxes.structure, tr('세션에서 서브에이전트와 Codex 실행으로 이어지는 위임 구조. 오른쪽 숫자는 처리 토큰, 괄호는 첫 관측부터 마지막 요청까지의 구간. 실선은 기록된 부모, 점선은 Codex 시간 매칭.',
    'Delegation structure from sessions to subagents and Codex runs. Right-hand numbers are processed tokens; parentheses show first observation to last request. Solid links are recorded parents; dashed links are Codex time matches.'), 'note');
  if (trees.length) chart(boxes.structure, tr('세션에서 서브에이전트와 Codex 실행으로 이어지는 위임 구조도', 'Delegation structure from sessions to subagents and Codex runs'), (el, W) => {
    const colX = [0, 304, 574], nodeW = [268, 240, W - 574], nodeH = 46, rowH = 56, groupGap = 14, rootGap = 28;
    const defs = el('defs', {});
    const marker = el('marker', {id:'structure-end',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'}, undefined, defs);
    el('path', {d:'M0,0 L10,5 L0,10 Z', fill:'var(--axis)'}, undefined, marker);
    const curve = (x1, y1, x2, y2, dashed) => el('path', {d:`M${x1},${y1} C${x1+(x2-x1)/2},${y1} ${x1+(x2-x1)/2},${y2} ${x2-2},${y2}`, fill:'none', stroke:'var(--axis)', 'stroke-width':1.4, 'stroke-dasharray':dashed ? '5 4' : '', 'marker-end':'url(#structure-end)'});
    const node = (x, y, w, o) => {
      const g = el('g', {});
      el('rect', {x, y, width:w, height:nodeH, rx:10, fill:'var(--raised)', stroke:o.ext ? 'var(--ext)' : 'var(--ring)', 'stroke-width':o.ext ? 1.4 : 1, 'stroke-dasharray':o.ext ? '5 4' : ''}, undefined, g);
      if (!o.ext && o.color) el('rect', {x:x+1, y:y+1, width:5, height:nodeH-2, rx:2.5, fill:`var(${o.color})`}, undefined, g);
      const clip = s => clipTo(s, w - 28 - (o.right ? 62 : 0));
      el('text', {x:x+16, y:y+19, class:'strong'}, clip(o.title), g);
      el('text', {x:x+16, y:y+36, class:'axis'}, clip(o.sub || ''), g);
      if (o.right) el('text', {x:x+w-12, y:y+28, 'text-anchor':'end', class:'strong'}, o.right, g);
      el('title', {}, o.tip || `${o.title} / ${o.sub}`, g);
    };
    const kinds = [
      ['agent', tr('서브에이전트', 'Subagents'), n => tr(`${n}개 에이전트`, `${n} agents`), false],
      ['session', tr('하위 세션', 'Child sessions'), n => tr(`${n}개 세션`, `${n} sessions`), false],
      ['external', tr('Codex 위임', 'Codex delegation'), n => tr(`교차 벤더 · ${n}회`, `Cross-vendor; ${n} runs`), true]];
    let y = 6;
    const roots = trees.map(({ s, kids }) => {
      const y0 = y, groups = [];
      kinds.forEach(([role, label, sub, ext]) => {
        const rows = kids.filter(k => k.role === role);
        if (!rows.length) return;
        const g0 = y;
        const leaves = rows.map(k => ({ k, y: (y += rowH) - rowH }));
        groups.push({ label, sub: sub(rows.length), ext, y: (g0 + y - rowH) / 2, leaves });
        y += groupGap;
      });
      const bottom = y - groupGap;
      y = bottom + rootGap;
      return { s, y: (y0 + bottom - rowH) / 2, groups };
    });
    roots.forEach(root => root.groups.forEach(g => {
      curve(colX[0] + nodeW[0], root.y + nodeH / 2, colX[1], g.y + nodeH / 2, g.ext);
      g.leaves.forEach(l => curve(colX[1] + nodeW[1], g.y + nodeH / 2, colX[2], l.y + nodeH / 2, g.ext));
    }));
    roots.forEach(({ s, y: ry, groups }) => {
      node(colX[0], ry, nodeW[0], {title:`${s.label} · ${tr('세션', 'Session')}`, sub:`${detailOf(s)} · ${minutes(s)}`, color:s.color, right:compact(s.value),
        tip:`${s.label} / ${s.detail} / ${time(s.start)} ~ ${time(s.end)} / ${fmt(s.value)}`});
      groups.forEach(g => {
        const total = g.leaves.reduce((sum, l) => sum + l.k.value, 0);
        node(colX[1], g.y, nodeW[1], {title:g.label, sub:g.sub, ext:g.ext, right:compact(total),
          tip:`${g.label} / ${g.sub} / ${fmt(total)}` + (g.ext ? tr(' / Codex 로그 토큰, 합계에 더하지 않음', ' / Codex log tokens, excluded from the total') : '')});
        g.leaves.forEach(({ k, y: ly }) => {
          const parts = k.detail.split(' · ');
          const ext = k.role === 'external';
          const title = ext ? parts.join(' · ') : k.role === 'session' ? `${k.label} · ${tr('세션', 'Session')}` : parts[0];
          const sub = [k.label, ...(ext || k.role === 'session' ? [] : parts.slice(1).map(shortModel)), `${time(k.start)}~${time(k.end)} (${minutes(k)})`].join(' · ');
          node(colX[2], ly, nodeW[2], {title, sub, color:k.color, ext, right:compact(k.value), tip:`${k.label} / ${k.detail} / ${time(k.start)} ~ ${time(k.end)} / ${fmt(k.value)}`});
        });
      });
    });
    return y - rootGap + 6;
  }, 760);
  else h('p', boxes.structure, tr('위임이 기록된 세션이 없습니다.', 'No session recorded a delegation.'), 'empty');
  if (idle.length) h('p', boxes.structure, tr(`위임 없는 세션 ${idle.length}개: `, `${idle.length} sessions without delegation: `) + idle.join(', '), 'note chart-note');
  h('p', boxes.timeline, map.text, 'note');
  chart(boxes.timeline, tr('세션과 서브에이전트, Codex 실행의 공통 시간축 위임 지도', 'Time-aligned session, subagent and Codex delegation map'), (el, W) => {
    const small = W < 600, L = small ? 8 : 220, R = W - 8, top = 32, rowH = small ? 70 : 46;
    const axis = map.axis || D.axis, span = Math.max(1, axis.t1 - axis.t0);
    const x = at => L + Math.max(0, Math.min(1, (at - axis.t0) / span)) * (R - L);
    const barY = i => top + i * rowH + (small ? 44 : 17);
    const height = top + mapRows.length * rowH + 8;
    grid(el, axis, L, R, top, height - 8, small ? 2 : 5);
    const defs = el('defs', {});
    const marker = el('marker', {id:'delegation-end',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'}, undefined, defs);
    el('path', {d:'M0,0 L10,5 L0,10 Z', fill:'var(--axis)'}, undefined, marker);
    mapRows.forEach((r, i) => {
      const parent = mapRows.findIndex(p => p.label === r.parent);
      if (parent >= 0 && parent !== i) {
        const at = x(r.start), yy = barY(i) + 6, py = barY(parent) + 6;
        el('path', {d:`M${Math.max(L,at-5)},${py} V${yy-7} Q${Math.max(L,at-5)},${yy} ${at},${yy}`,fill:'none',stroke:'var(--axis)','stroke-width':1.2,'stroke-dasharray':r.role === 'external' ? '3 3' : '', 'marker-end':'url(#delegation-end)'});
      }
    });
    mapRows.forEach((r, i) => {
      const yy = top + i * rowH;
      const role = r.role === 'external' ? 'Codex' : r.role === 'agent' ? tr('서브', 'Subagent') : tr('세션', 'Session');
      const title = `${r.label} · ${role}`;
      el('rect', {x:0,y:yy,width:small ? W : L-10,height:small ? 37 : rowH-2,fill:'var(--surface)'});
      el('text', {x:0,y:yy+13,class:'strong'}, title);
      el('text', {x:small ? W : L-16,y:yy+13,'text-anchor':'end',class:'axis'}, compact(r.value));
      const detail = r.detail.split(' · ').map(shortModel).join(' · ');
      el('text', {x:0,y:yy+29,class:'axis'}, detail.length > (small ? 46 : 33) ? detail.slice(0,small ? 43 : 30) + '…' : detail);
      const start = x(r.start), bw = Math.max(2, x(r.end)-start);
      const rect = el('rect', {x:Math.min(start,R-2),y:barY(i),width:Math.min(bw,R-Math.min(start,R-2)),height:12,rx:3,fill:r.role === 'external' ? 'var(--raised)' : `var(${r.color})`,stroke:r.role === 'external' ? 'var(--ext)' : 'none','stroke-dasharray':r.role === 'external' ? '4 2' : ''});
      el('title', {}, `${title} / ${r.detail} / ${time(r.start)} ~ ${time(r.end)} / ${fmt(r.value)}`, rect);
      el('line', {x1:0,x2:W,y1:yy+rowH-3,y2:yy+rowH-3,class:'grid-line'});
    });
    return height;
  });
  h('p', mapPanel, get('helpers').title + tr('은 상세 목록으로 접었습니다. 막대는 관측 구간이며 빈 구간을 작업 시간으로 해석하지 않습니다.', ' are collapsed in details. Bars are observed spans, not continuous work.'), 'note chart-note');
  const activity = get('activity');
  const timeline = section(activity.title, activity.text);
  legend(timeline, [...modelEntries, [tr('Codex 외부 실행', 'External Codex runs'), '--ext']]);
  const events = activity.chart.filter(r => r.role !== 'bucket' && r.role !== 'span');
  const laneBoxes = viewToggle(timeline, tr('타임라인 보기 방식', 'Timeline view'), [['lanes', tr('레인별 구간', 'Lanes')], ['bars', tr('토큰 막대', 'Token bars')]], 'timeline');
  // 레인 보기(이전 AAR 방식): 메인 루프 구간과 서브에이전트·Codex 구간을 레인에 놓고, 위쪽 띠는 태그 사이 구간.
  const spans = activity.chart.filter(r => r.role === 'span');
  const repLabel = spans.length ? spans[0].group : activity.text.split(' · ')[0];
  const laneKey = r => r.role === 'external' ? 'Codex' : r.detail.split(' · ')[0];
  const lanes = [[tr('메인 루프', 'Main loop'), spans.map(r => ({ r, ext: false, title: `${tr('메인 루프', 'Main loop')} / ${shortModel(r.label)}` }))]];
  mapRows.filter(r => r.parent === repLabel && r.label !== repLabel).forEach(r => {
    const key = laneKey(r);
    let lane = lanes.find(l => l[0] === key);
    if (!lane) { lane = [key, []]; lanes.push(lane); }
    lane[1].push({ r, ext: r.role === 'external', title: `${r.label} / ${r.detail}` });
  });
  const tags = events.filter(e => e.role === 'tag');
  h('p', laneBoxes.lanes, tr('메인 루프 막대는 요청 간격 5분 이내를 한 구간으로 묶은 것, 서브에이전트·Codex 막대는 첫 관측부터 마지막 요청까지. 위쪽 띠는 태그 사이 구간.',
    'Main-loop bars join requests at most five minutes apart; subagent and Codex bars run from first observation to last request. Top bands are the spans between tags.')
    + (tags.length ? '' : tr(' 이 세션에는 태그가 없어 띠가 없다.', ' This session has no tags, so there are no bands.')), 'note');
  chart(laneBoxes.lanes, tr('대표 세션의 레인별 작업 구간 타임라인', 'Lane timeline of the representative session'), (el, W) => {
    const axis = activity.axis, L = 150, R = W - 12, laneH = 40, T = tags.length ? 58 : 30, span = Math.max(1, axis.t1 - axis.t0);
    const x = at => L + Math.max(0, Math.min(1, (at - axis.t0) / span)) * (R - L);
    const bottom = T + lanes.length * laneH;
    tags.forEach((t, i) => {
      const from = x(t.start), to = x(tags[i + 1] ? tags[i + 1].start : axis.t1);
      el('rect', {x:from + (i ? 1 : 0), y:4, width:Math.max(0, to - from - 2), height:38, rx:6, fill:i % 2 ? 'var(--gold-t)' : 'var(--accent-t)'});
      el('text', {x:(from + to) / 2, y:28, 'text-anchor':'middle', class:'axis'}, clipTo(t.label, to - from - 10));
      el('line', {x1:from, x2:from, y1:T - 4, y2:bottom, class:'grid-line'});
    });
    lanes.forEach(([label, items], i) => {
      const yy = T + i * laneH;
      el('line', {x1:L, x2:R, y1:yy + laneH, y2:yy + laneH, class:'grid-line'});
      el('text', {x:L - 12, y:yy + laneH / 2 + 4, 'text-anchor':'end', class:'strong'}, clipTo(label, L - 16));
      items.forEach(({ r, ext, title }) => {
        const a = x(r.start), b = Math.max(a + 6, x(r.end));
        const rect = el('rect', {x:a, y:yy + 12, width:b - a, height:16, rx:4, fill:ext ? 'var(--raised)' : `var(${r.color})`, stroke:ext ? 'var(--ext)' : 'none', 'stroke-width':ext ? 1.4 : 0, 'stroke-dasharray':ext ? '4 3' : ''});
        el('title', {}, `${title} / ${time(r.start)} ~ ${time(r.end)} / ${fmt(r.value)}`, rect);
      });
    });
    const marks = events.filter(e => e.role !== 'tag');
    marks.forEach((r, i) => {
      const xx = x(r.start);
      el('line', {x1:xx, x2:xx, y1:T, y2:bottom, stroke:`var(${r.color})`, 'stroke-dasharray':'3 3'});
      el('circle', {cx:xx, cy:T + 6, r:5, fill:`var(${r.color})`});
      el('text', {x:Math.max(L + 8, Math.min(R - 8, xx)), y:bottom + 38 + (i % 2) * 15, 'text-anchor':'middle', class:'strong'}, String(events.indexOf(r) + 1));
    });
    el('line', {x1:L, x2:R, y1:bottom, y2:bottom, stroke:'var(--axis)'});
    const count = 6;
    for (let i = 0; i <= count; i++) {
      const at = axis.t0 + Math.round((axis.t1 - axis.t0) / axis.bucketMs * i / count) * axis.bucketMs;
      el('text', {x:x(at), y:bottom + 18, 'text-anchor':i === 0 ? 'start' : i === count ? 'end' : 'middle', class:'axis'}, time(at));
    }
    return bottom + (marks.length ? 58 : 26);
  }, 760);
  h('p', laneBoxes.bars, tr('5분 묶음 모델별 처리 토큰. 번호 표식은 태그·압축·중단.', 'Five-minute processed tokens by model. Numbered markers are tags, compactions and interruptions.'), 'note');
  chart(laneBoxes.bars, tr('5분 묶음 모델별 처리 토큰 누적 막대와 태그·압축·중단 표시', 'Five-minute stacked token bars with tag, compaction and interruption markers'), (el, W) => {
    const axis = activity.axis, buckets = activity.chart.filter(r => r.role === 'bucket');
    const sums = new Map();
    buckets.forEach(r => sums.set(r.start,(sums.get(r.start)||0) + r.value));
    const max = Math.max(1,...sums.values()), L = 42, R = W-4, T = 34, B = 202, span = Math.max(1,axis.t1-axis.t0);
    const x = at => L + (at-axis.t0)/span*(R-L);
    for(let i=0;i<=3;i++) {
      const y = B - i/3*(B-T);
      el('line',{x1:L,x2:R,y1:y,y2:y,class:'grid-line'});
      el('text',{x:L-7,y:y+4,'text-anchor':'end',class:'axis'},compact(max*i/3));
    }
    const used = new Map();
    buckets.forEach(r => {
      const acc = used.get(r.start)||0, height = r.value/max*(B-T);
      const rect = el('rect',{x:x(r.start)+1,y:B-(acc+r.value)/max*(B-T),width:Math.max(.5,x(r.end)-x(r.start)-2),height,rx:1,fill:`var(${r.color})`});
      el('title',{},`${time(r.start)} / ${shortModel(r.label)} / ${fmt(r.value)}`,rect);
      used.set(r.start,acc+r.value);
    });
    const count = W < 500 ? 2 : 6;
    for(let i=0;i<=count;i++) {
      const at = axis.t0 + Math.round((axis.t1-axis.t0)/axis.bucketMs*i/count)*axis.bucketMs;
      el('text',{x:x(at),y:B+20,'text-anchor':i===0?'start':i===count?'end':'middle',class:'axis'},time(at));
    }
    const peak = [...sums].sort((a,b)=>b[1]-a[1])[0];
    if(peak) el('text',{x:Math.min(R-30,Math.max(L+30,x(peak[0])+4)),y:20,'text-anchor':'middle',class:'strong'},compact(peak[1]));
    events.forEach((r,i) => {
      const xx = x(Math.max(axis.t0,Math.min(axis.t1,r.start)));
      el('line',{x1:xx,x2:xx,y1:T,y2:B,stroke:`var(${r.color})`,'stroke-dasharray':'3 3'});
      el('circle',{cx:xx,cy:T+6,r:5,fill:`var(${r.color})`});
      el('text',{x:Math.max(8,Math.min(W-16,xx)),y:245+(i%2)*17,'text-anchor':'middle',class:'strong'},String(i+1));
    });
    return events.length ? 270 : 233;
  });
  const badges = h('div', timeline, undefined, 'badges');
  activity.rows.forEach(row => {
    const b = h('span',badges,undefined,'badge'); h('span',b,row[0]); h('b',b,row[1] == null ? tr('미측정','Unmeasured') : fmt(row[1])); if(row[2])h('small',b,row[2]);
  });
  if(events.length) {
    const list = h('div',timeline,undefined,'markers');
    events.forEach((e,i)=>h('span',list,`${i+1}. ${time(e.start)} ${e.label}`,'marker-item'));
  }
  activity.cards.forEach(c=>h('p',timeline,c.body,'note chart-note'));
  const mix = section(tr('토큰은 어디에 쓰였나', 'Where the tokens went'), tr('캐시 읽기를 제외한 처리 토큰. 두 차트는 같은 합계를 모델과 루프로 나누어 본다.', 'Processed tokens exclude cache reads. Both charts show the same total by model and by loop.'));
  const pair = h('div',mix,undefined,'split');
  const stack = (parent,s,byModel) => {
    h('h3',parent,s.title);
    legend(parent,byModel ? [[tr('메인','Main'),'--accent'],[tr('서브에이전트','Subagents'),'--accent',.38]] : modelEntries);
    chart(parent,s.title,(el,W)=>{
      const names = [...new Set(s.chart.map(r=>r.label))];
      const total = name => s.chart.filter(r=>r.label===name).reduce((sum,r)=>sum+r.value,0);
      const max = Math.max(1,...names.map(total));
      let y = 0;
      names.forEach(name=>{
        el('text',{x:0,y:y+15,class:'strong'},shortModel(name));
        el('text',{x:W,y:y+15,'text-anchor':'end',class:'strong'},compact(total(name)));
        el('rect',{x:0,y:y+27,width:W,height:15,rx:4,fill:'var(--grid)'});
        let x=0;
        s.chart.filter(r=>r.label===name).forEach(r=>{
          const width=W*r.value/max;
          const opacity = byModel && r.group===tr('서브에이전트','Subagents') ? .38 : 1;
          const rect=el('rect',{x,y:y+27,width,height:15,fill:`var(${byModel?'--accent':r.color})`,opacity});
          el('title',{},`${r.group}: ${fmt(r.value)}`,rect);
          x+=width;
        });
        const shares=s.chart.filter(r=>r.label===name).map(r=>`${shortModel(r.group)} ${Math.round(r.value/Math.max(1,total(name))*100)}%`);
        let line = '', lineNo = 0;
        const limit = Math.max(20,Math.floor(W/7));
        shares.forEach(part=>{
          if(line && line.length + part.length + 3 > limit) {
            el('text',{x:0,y:y+56+lineNo*16,class:'axis'},line); lineNo++; line='';
          }
          line += (line ? ' / ' : '') + part;
        });
        el('text',{x:0,y:y+56+lineNo*16,class:'axis'},line);
        y += 68 + lineNo*16;
      });
      return Math.max(24,y);
    });
  };
  stack(h('div',pair),{...get('models'),title:tr('모델별','By model')},true);
  stack(h('div',pair),{...get('loops'),title:tr('루프별','By loop')},false);
  const external = get('external');
  const ext = h('div',mix,undefined,'external');
  h('h3',ext,tr('Codex 외부 사용량 · 합계에 더하지 않음','External Codex usage; excluded from the total'));
  if(external) {
    h('p',ext,tr('Codex 로그에서 별도로 집계한 처리 토큰. Claude 래퍼와 외부 실행은 서로 다른 사용량입니다.','Separately counted from Codex logs. Claude wrapper and external usage are distinct.'),'note');
    chart(ext,external.title,(el,W)=>{
      const max=Math.max(1,...external.chart.map(r=>r.value));
      external.chart.forEach((r,i)=>{
        const y=i*54;
        el('text',{x:0,y:y+15,class:'strong'},r.label+' · '+shortModel(r.group));
        el('text',{x:W,y:y+15,'text-anchor':'end',class:'strong'},compact(r.value));
        el('rect',{x:0,y:y+26,width:W*r.value/max,height:13,rx:3,fill:'var(--ext)'});
      });
      return external.chart.length*54;
    });
  } else h('p',ext,tr('해당 기간에 연결된 외부 실행이 없습니다.','No matched external runs in this period.'),'note');
  const friction = h('section',main,undefined,'badges section');
  friction.setAttribute('aria-label',tr('마찰과 정본 지문','Friction and canonical fingerprints'));
  get('friction').cards.forEach(c=>{
    const b=h('span',friction,undefined,'badge');h('span',b,c.title);h('b',b,c.body);h('small',b,c.badge);
  });
  const fingerprint=h('span',friction,undefined,'badge');h('span',fingerprint,get('fingerprint').title);h('b',fingerprint,get('fingerprint').text);
  const hypotheses=get('hypotheses');
  const hyp=section(hypotheses.title,hypotheses.text);
  if(hypotheses.cards?.length) {
    const g=h('div',hyp,undefined,'hypotheses');
    hypotheses.cards.forEach(c=>{const a=h('article',g,undefined,'hypothesis');h('span',a,c.badge,'tag');h('h3',a,c.title);h('p',a,c.body);});
  } else h('p',hyp,tr('현재 임계값에 해당하는 가설이 없습니다.','No hypotheses meet the current thresholds.'),'empty');
  const declarations=get('declarations');
  if(declarations) {
    const sec=section(declarations.title,tr('프로필의 역할 선언과 관측된 호출·처리 토큰을 대조합니다.','Compare profile declarations with observed calls and tokens.'));
    const g=h('div',sec,undefined,'declarations');
    declarations.rows.forEach((r,i)=>{
      const a=h('article',g,undefined,'declaration');h('h3',a,r[0]);h('p',a,r[1]);
      h('p',a,`${fmt(r[2])} ${i===0?tr('세션','sessions'):tr('호출','spawns')} / ${compact(r[3])} ${tr('토큰','tokens')}`);
    });
  }
  const cell=(parent,v)=>{
    if(v&&typeof v==='object') {h('span',parent,String(v.value));const b=h('span',parent,tr('추정','Estimated'),'tag');b.title=v.basis;}
    else h('span',parent,v==null?tr('측정 안 됨','Not measured'):String(v));
  };
  const table=(parent,s)=>{
    const wrap=h('div',parent,undefined,'table-wrap'), t=h('table',wrap);
    if(s.headers) {const row=h('tr',h('thead',t));s.headers.forEach(v=>{const th=h('th',row,v);th.scope='col';});}
    const body=h('tbody',t);
    (s.rows||[]).forEach(row=>{const trr=h('tr',body);row.forEach(v=>cell(h('td',trr),v));});
  };
  const detailStack=h('section',main,undefined,'detail-stack');
  detailStack.setAttribute('aria-label',tr('상세 수치','Detailed figures'));
  ['helpers','sessions','models','ledger','external','friction','fingerprint','coverage'].forEach(kind=>{
    const s=get(kind);if(!s)return;
    const d=h('details',detailStack);h('summary',d,s.title);
    if(s.text)h('p',d,s.text,'note');
    if(s.rows?.length)table(d,s);else h('p',d,tr('기록 없음','No records'),'note');
  });
  const footer=h('footer',main);
  h('p',footer,tr('기록 범위: ','Coverage: ')+overview,'note');
  h('p',footer,tr('기간 필터는 세션 선택 기준입니다. 선택한 세션의 전체 기록을 표시하므로 종료 시각이 조회 기간을 넘을 수 있습니다. 본문과 도구 입력은 포함하지 않습니다.','The period selects sessions. Full selected-session records can extend beyond the query end. Message bodies and tool inputs are excluded.'),'note');
})();
