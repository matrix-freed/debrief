"""AAR 시각화용 투영. 원본 식별자 대신 보고서 별칭만 내보낸다."""
from collections import Counter


def processed(usage):
    return sum(usage.get(k, 0) for k in ('in', 'cacheWrite', 'out'))


def union_ms(spans):
    total, end = 0, None
    for a, b in sorted(spans):
        if end is None or a > end:
            total, end = total + b - a, b
        elif b > end:
            total, end = total + b - end, b
    return total


def prepare(data, sessions, records, runs, profile, totals):
    en = data['language'] == 'en'
    def tr(ko, eng):
        return eng if en else ko
    def section(ko, eng):
        return next(s for s in data['sections'] if s['title'] == tr(ko, eng))
    def model_name(model):
        return model or tr('모델 미수집', 'Model unavailable')
    def number(value):
        return format(value, ',')

    data['layout'] = 'aar'
    data['sections'][0]['kind'] = 'overview'
    # Automated helpers: an SDK entrypoint, no subagents, and one request or five minutes at most.
    auxiliary = {s['index'] for s in sessions
                 if (s['requests'] <= 1 or s['endedAt'] - s['startedAt'] <= 300000)
                 and all(str(r.get('run', {}).get('surface') or '').startswith('sdk') for r in records[s['index']])
                 and not any(r.get('agents') for r in records[s['index']])}
    missing = sum(any('usdAtEnd' not in r.get('cost', {}) or 'usdAtStart' not in r.get('cost', {})
                      for r in records[s['index']]) for s in sessions)
    estimated = sum(bool(s.get('estimated')) for s in sessions)
    summed = sum(s['endedAt'] - s['startedAt'] for s in sessions) / 60000
    work = union_ms([(s['startedAt'], s['endedAt']) for s in sessions]) / 60000
    elapsed = (data['axis']['t1'] - data['axis']['t0']) / 60000
    data['sections'][1]['cards'] = [
        dict(title=tr('처리 토큰', 'Processed tokens'), body=number(totals['processed']),
             evidence=[tr('입력 + 캐시 쓰기 + 출력', 'Input + cache write + output'), tr('캐시 읽기 제외 · Codex 별도', 'Excludes cache reads; Codex separate')]),
        dict(title=tr('비용', 'Cost'), body='$%.2f' % totals['usdTotal'],
             evidence=[tr('엔진 장부 · API 환산 · 세션 누적', 'Engine ledger; API equivalent; session cumulative'),
                       tr(f'장부 없는 세션 {missing}개는 0으로 셈', f'{missing} sessions without a ledger counted as zero'),
                       tr(f'비용 누락·음수 차이 등 추정 {estimated}개', f'{estimated} estimated sessions, including missing or negative deltas')]),
        dict(title=tr('작업 시간', 'Work time'), body=f'{work:,.1f}', badge=tr('분', 'min'),
             evidence=[tr('세션 구간 합집합 · 겹침 제거', 'Union of session spans, overlap removed'), tr(f'겹침 포함 합 {summed:,.1f}분 · 전체 경과 {elapsed:,.1f}분', f'Sum with overlap {summed:,.1f} min; elapsed {elapsed:,.1f} min')]),
        dict(title=tr('세션 수', 'Sessions'), body=str(len(sessions) - len(auxiliary)), badge=tr('개', 'sessions'),
             evidence=[tr(f'자동 보조 {len(auxiliary)}건', f'{len(auxiliary)} automatic helpers'), tr(f'전체 {len(sessions)}개 · sdk 단발 별도', f'{len(sessions)} total; one-shot SDK sessions separate')])]
    section('계획 / 실제 / 차이 / 개선', 'Plan / Actual / Gap / Improvement')['kind'] = 'review'
    section('개선 항목', 'Improvements')['kind'] = 'improvements'
    model_section = section('모델별 처리 토큰 / 모델과 루프', 'Processed tokens by model / loop')
    colors = {r['label']: r['color'] for r in model_section['chart']}
    # 한 요청은 하나의 루프에만 속한다. 상세 표의 agent 합 행과 유형 행을 다시 더하지 않는다.
    model_parts, loop_parts = Counter(), Counter()
    lanes = []
    sid_index = {s['sessionId']: s['index'] for s in sessions}
    lane_model = (profile or {}).get('mainLane', tr('메인', 'Main'))
    for s in sessions:
        si = s['index']
        rr = records[si]
        agents = {key: a for r in rr for key, a in r.get('agents', {}).items()}
        main = max(s['usage'].get('main', {}), key=lambda m: processed(s['usage']['main'][m]), default='')
        for loop, mm in s['usage'].items():
            group = tr('메인', 'Main') if loop == 'main' else tr('서브에이전트', 'Subagents')
            for model, u in mm.items():
                model_parts[model, group] += processed(u)
                loop_parts[group, model] += processed(u)
        if si in auxiliary:
            continue
        parent = next((sid_index.get(r.get('parentSessionId'), '') for r in rr if r.get('parentSessionId')), '')
        lanes.append(dict(label=si, group=si, role='session', parent=parent,
                          detail=lane_model + ' · ' + model_name(main), color=colors.get(main, '--ext'),
                          start=s['startedAt'], end=s['endedAt'], value=s['processed']))
        for i, (key, a) in enumerate(agents.items(), 1):
            start = a.get('firstSeenAt', s['startedAt'])
            # durationMs는 턴 합이므로 연속 벽시계 구간으로 단정하지 않는다.
            seen = [step['at'] for r in rr for step in r.get('steps', []) if step.get('loop') == key and isinstance(step.get('at'), (int, float))]
            end = max([start] + seen)
            kind = a.get('subagentType') or tr('유형 미선언', 'Undeclared type')
            label = (profile or {}).get('lanes', {}).get(kind, kind)
            lanes.append(dict(label=si + '-A' + str(i), group=si, role='agent', parent=si,
                              detail=label + ' · ' + model_name(a.get('model')), color=colors.get(a.get('model'), '--ext'),
                              start=start, end=end, value=sum(processed(u) for u in s['usage'].get(key, {}).values())))
    for i, run in enumerate(runs, 1):
        lanes.append(dict(label='X' + str(i), group=run.get('matchedSession') or '', role='external',
                          parent=run.get('matchedSession') or '', detail='Codex · ' + model_name(run.get('model')),
                          start=run['startedAt'], end=run['endedAt'], value=run['tokens']['processed'], color='--ext'))
    delegation = section('위임 지도(시간축 겹침)', 'Delegation map (time overlap)')
    delegation.update(kind='delegation', chart=lanes,
                      text=tr('같은 시간축에서 겹치는 실행을 비교한다. 실선은 기록된 부모, 점선은 Codex 시간 매칭. 서브 막대는 첫 관측부터 마지막 요청까지이며 연속 작업 시간을 뜻하지 않는다.',
                              'Compare overlapping activity on a shared clock. Solid links are recorded parents; dashed links are Codex time matches. Subagent spans run from first observation to last request, not continuous work.'))
    if lanes:
        a = min(r['start'] for r in lanes)
        b = max(r['end'] for r in lanes)
        delegation['axis'] = dict(t0=min(a, data['axis']['t0']), t1=max(b, data['axis']['t1']), tickMs=data['axis']['tickMs'], bucketMs=300000)
    model_section.update(kind='models', chart=[dict(label=m, group=g, value=v, color=colors[m]) for (m, g), v in model_parts.items() if v > 0])
    data['sections'].append(dict(title=tr('루프별 처리 토큰', 'Processed tokens by loop'), kind='loops',
                                chart=[dict(label=g, group=m, value=v, color=colors[m]) for (g, m), v in loop_parts.items() if v > 0]))
    section('비용과 장부', 'Cost and ledger')['kind'] = 'ledger'
    if runs:
        section('Codex 외부 사용량', 'Codex external usage').update(kind='external',
            chart=[dict(label='X' + str(i), group=model_name(r.get('model')), value=r['tokens']['processed'], color='--ext') for i, r in enumerate(runs, 1)])
    listing = section('세션 목록과 관계', 'Sessions and relationships')
    helpers = [row for row in listing['rows'] if row[0] in auxiliary]
    listing.update(kind='sessions', rows=[row for row in listing['rows'] if row[0] not in auxiliary])
    data['sections'].append(dict(title=tr(f'자동 보조 {len(helpers)}건', f'{len(helpers)} automatic helpers'), kind='helpers',
                                text=tr('sdk-cli·sdk-py의 요청 1회, 서브에이전트 없는 세션. 처리 토큰과 비용 합계에는 포함한다.',
                                        'One-request SDK sessions without subagents. Included in token and cost totals.'), headers=listing['headers'], rows=helpers))
    representative = max(sessions, key=lambda s: s['processed'])
    rep = records[representative['index']]
    r0, r1 = representative['startedAt'], representative['endedAt']
    buckets = Counter()
    markers = []
    bucket_ms = 300000
    main_steps = []
    for r in rep:
        for step in r.get('steps', []):
            at = step.get('at')
            if isinstance(at, (int, float)) and r0 <= at <= r1:
                buckets[int(at // bucket_ms) * bucket_ms, step.get('model', '')] += processed(step.get('usage') or {})
                if step.get('loop') == 'main':
                    main_steps.append((at, step.get('model', ''), processed(step.get('usage') or {})))
        for tag in r.get('tags', []):
            if isinstance(tag, dict) and isinstance(tag.get('at'), (int, float)):
                markers.append(dict(label=tag.get('label', tag.get('name', tr('태그', 'Tag'))), start=tag['at'], end=tag['at'], role='tag', color='--accent'))
        for turn in r.get('turns', []):
            at = turn.get('startedAt')
            if turn.get('aborted') and isinstance(at, (int, float)):
                at += turn.get('durationMs', 0)
                markers.append(dict(label=tr('중단', 'Aborted'), start=at, end=at, role='aborted', color='--bad'))
        # Backfill keeps compaction boundary times and flags aborted requests on their step.
        for ev in r.get('events', []):
            if ev.get('kind') == 'compaction' and isinstance(ev.get('at'), (int, float)):
                markers.append(dict(label=tr('압축', 'Compaction'), start=ev['at'], end=ev['at'], role='compactions', color='--gold'))
        for step in r.get('steps', []):
            if step.get('aborted') and isinstance(step.get('at'), (int, float)):
                markers.append(dict(label=tr('중단', 'Aborted'), start=step['at'], end=step['at'], role='aborted', color='--bad'))
    # 메인 루프 구간: 요청 간격이 5분 이내이고 모델이 같으면 한 구간으로 묶는다(레인 타임라인용).
    spans = []
    for at, model, value in sorted(main_steps):
        last = spans[-1] if spans else None
        if last and last['model'] == model and at - last['end'] <= bucket_ms:
            last['end'], last['value'] = at, last['value'] + value
        else:
            spans.append(dict(model=model, start=at, end=at, value=value))
    timeline = section('대표 세션 타임라인', 'Representative session timeline')
    rows = []
    for field, label, english in [('compactions', '압축', 'Compactions'), ('aborted', '중단', 'Aborted')]:
        values = [r.get('friction', {}).get(field) for r in rep]
        value = sum(v for v in values if isinstance(v, (int, float))) if any(v is not None for v in values) else None
        timed = sum(m['role'] == field for m in markers)
        rows.append([tr(label, english), value, tr(f'{max(0, value - timed)}건 시각 미수집', f'{max(0, value - timed)} event times unavailable') if value and value > timed else ''])
    timeline.update(kind='activity', text=representative['index'] + tr(' · 처리 토큰이 가장 큰 세션 · 5분 묶음', ' · Highest-token session · 5-minute buckets'),
                    axis=dict(t0=r0 // bucket_ms * bucket_ms, t1=max(r0 // bucket_ms * bucket_ms + bucket_ms, (r1 // bucket_ms + 1) * bucket_ms), tickMs=bucket_ms, bucketMs=bucket_ms),
                    chart=[dict(label=model_name(m), start=at, end=at + bucket_ms, value=v, color=colors.get(m, '--ext'), role='bucket') for (at, m), v in sorted(buckets.items())]
                          + [dict(label=model_name(s['model']), group=representative['index'], start=s['start'], end=s['end'], value=s['value'], color=colors.get(s['model'], '--ext'), role='span') for s in spans]
                          + markers,
                    rows=rows,
                    cards=[dict(title=tr('기록 범위', 'Coverage'), body=tr(f"5분 막대 {number(sum(buckets.values()))} / 대표 세션 {number(representative['processed'])} 토큰. 요청 기록이 잘리거나 압축되면 막대 합이 세션 합보다 작을 수 있다. 태그 {sum(m['role'] == 'tag' for m in markers)}건.",
                        f"Buckets {number(sum(buckets.values()))} / session {number(representative['processed'])} tokens. Truncated or compacted step records may reduce bucket totals. {sum(m['role'] == 'tag' for m in markers)} tags."))])
    friction = section('마찰 카운터', 'Friction counters')
    friction['kind'] = 'friction'
    friction['cards'] = []
    for col, label, english in [(1, '중단', 'Aborted'), (2, '도구 오류', 'Tool errors'), (3, '거부', 'Rejected'), (4, '압축', 'Compactions')]:
        values = [row[col] for row in friction['rows']]
        known = [v for v in values if v is not None]
        friction['cards'].append(dict(title=tr(label, english), body=str(sum(known)) if known else tr('미측정', 'Unmeasured'),
                                     badge=tr(f'{len(known)}/{len(values)} 세션 측정', f'{len(known)}/{len(values)} sessions measured')))
    section('정본 지문 변화', 'Canonical fingerprint changes')['kind'] = 'fingerprint'
    hypothesis = section('메타데이터 가설', 'Metadata hypotheses')
    hypothesis['kind'] = 'hypotheses'
    standard = (profile or {}).get('thresholdStyle') == 'standard'
    overrides = (profile or {}).get('hypotheses', {})
    def threshold(ident, key, fallback):
        item = overrides.get(ident, {})
        value = item.get(key, fallback) if isinstance(item, dict) else fallback
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else fallback
    minutes = threshold('long-no-subagent', 'minutes', overrides.get('longSessionMinutes', 60 if standard else 120))
    req = threshold('single-top-model', 'requests', 20 if standard else 50)
    share = threshold('single-top-model', 'share', .9 if standard else .98)
    calls = threshold('tool-error-rate', 'calls', 10 if standard else 20)
    rate = threshold('tool-error-rate', 'rate', .08 if standard else .1)
    hypothesis['text'] = tr('메타데이터만으로 만든 가설이며 작업 품질의 판정이 아니다. ', 'Metadata hypotheses, not quality judgments. ') + (tr('프로필 임계값', 'Profile thresholds') if profile else tr('프로필 없음', 'No profile')) + ' · ' + tr('표준 기본값' if standard else '보수적 기본값', 'Standard defaults' if standard else 'Conservative defaults') + tr(f' / 무위임 {minutes}분 이상 / 모델 집중 {req}요청 이상·{share:.0%} 이상 / 도구 {calls}회 이상·오류 {rate:.0%} 초과', f' / no delegation ≥{minutes} min / model concentration ≥{req} requests, ≥{share:.0%} / ≥{calls} tool calls, errors >{rate:.0%}')
    if profile:
        declared = section('선언 대 실제', 'Declared versus actual')
        declared['kind'] = 'declarations'
        work_sessions = [s for s in sessions if s['index'] not in auxiliary]
        main_row = declared['rows'][0]
        main_row[1] = main_row[1] + tr(f' · 작업 세션 기준, 자동 보조 {len(auxiliary)}건 별도', f'; work sessions only, {len(auxiliary)} automatic helpers apart')
        main_row[2] = len(work_sessions)
        main_row[3] = sum(processed(u) for s in work_sessions for u in s['usage'].get('main', {}).values())
    section('도구 상위 10과 기록 범위', 'Top 10 tools and coverage')['kind'] = 'coverage'
