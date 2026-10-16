"""세션 적재 및 중복 수집 대조."""
from pathlib import Path
from paths import millis, read_json
from transcript import COUNTERS


def sum_usage(records):
    result = {}
    for record in records:
        for loop, models in record.get('usage', {}).items():
            for model, usage in models.items():
                acc = result.setdefault(loop, {}).setdefault(model, dict.fromkeys(COUNTERS + ('steps', 'nullUsageSteps'), 0))
                for key in acc:
                    acc[key] += usage.get(key, 0)
    return result


def comparison(records):
    return {loop: {model: [u[k] for k in COUNTERS] + [u['steps']-u['nullUsageSteps']] for model,u in models.items()} for loop,models in sum_usage(records).items()}


def load_project(root, slugs=(), t0=None, t1=None):
    root = Path(root)
    selected = project_records(root, slugs)
    sessions = []
    for (slug, sid), records in selected.items():
        start = min(r['run']['startedAt'] for r in records)
        end = max(r['run'].get('endedAt', r['run']['startedAt']) for r in records)
        if (t0 is not None and end < millis(t0)) or (t1 is not None and start > millis(t1)):
            continue
        usage = sum_usage(records)
        usd, estimated = 0, False
        for record in records:
            cost = record.get('cost', {})
            delta = cost.get('usdAtEnd', 0) - cost.get('usdAtStart', 0)
            estimated |= cost.get('estimated', False) or 'usdAtEnd' not in cost or 'usdAtStart' not in cost or delta < 0
            usd += max(0, delta)
        values = [u for models in usage.values() for u in models.values()]
        sessions.append(dict(sessionId=sid, project=dict(slug=slug), startedAt=start, endedAt=end, usage=usage, processed=sum(u['in']+u['cacheWrite']+u['out'] for u in values), cacheRead=sum(u['cacheRead'] for u in values), requests=sum(u['steps']-u['nullUsageSteps'] for u in values), usdTotal=round(usd, 12), estimated=estimated, source=records[0].get('source')))
    sessions.sort(key=lambda s: (s['startedAt'], s['sessionId']))
    for i, session in enumerate(sessions, 1):
        session['index'] = 'S' + str(i)
    return sessions


def overlap(root, slugs=(), minimum=3):
    root = Path(root)
    result = dict(compared=0, matched=0, diffs=0)
    for folder in sorted((root / 'runs').glob('*/*')):
        if slugs and folder.parent.name not in slugs:
            continue
        back = root / '_backfill' / folder.parent.name / folder.name / 'backfill.json'
        files = sorted(folder.glob('*.json'))
        if not files or not back.is_file():
            continue
        result['compared'] += 1
        different = comparison([read_json(p) for p in files]) != comparison([read_json(back)])
        result['diffs'] += int(different)
        result['matched'] += int(not different)
    return result, int(result['diffs'] > 0 or result['compared'] < minimum)


def sum_counts(left, right):
    result = dict(left)
    for key, value in right.items():
        if isinstance(value, dict):
            result[key] = sum_counts(result.get(key, {}), value)
        elif value is not None:
            result[key] = (result.get(key) or 0) + value
        else:
            result.setdefault(key, None)
    return result


def summary_record(record):
    """링과 비허용 메타데이터를 버리고 합산 가능한 요약을 만든다."""
    run, cost = record['run'], record.get('cost', {})
    delta = cost.get('usdAtEnd', 0) - cost.get('usdAtStart', 0)
    result = dict(source=record.get('source') or 'mod', runIds=[record['runId']],
                  startedAt=run['startedAt'], endedAt=run.get('endedAt', run.get('lastCheckpointAt', run['startedAt'])),
                  usage=sum_usage([record]), effort=record.get('effort', {}),
                  cost=dict(usdAtStart=0, usdAtEnd=max(0, delta), provenance=cost.get('provenance', 'unknown'),
                            estimated=cost.get('estimated', False) or delta < 0 or 'usdAtEnd' not in cost or 'usdAtStart' not in cost),
                  agents={key: {k: a[k] for k in ('subagentType','model','firstSeenAt','durationMs') if k in a} for key,a in record.get('agents', {}).items()},
                  friction={k:record.get('friction', {}).get(k) for k in ('aborted','toolErrors','rejected','compactions')},
                  tags=[{k:t[k] for k in ('label','at','turnIndex') if k in t} for t in record.get('tags', [])],
                  instructions=[{k:i[k] for k in ('memoryType','loadReason','pathHash','contentHash','bytes','mtimeMs') if k in i} for i in record.get('instructions', [])],
                  requestedToolCalls=record.get('requestedToolCalls', {}))
    if 'ledger' in record:
        ledger = record['ledger']
        result['ledger'] = dict(groups=ledger.get('groups', 0), models={m:{k:u[k] for k in COUNTERS + ('usd',) if k in u} for m,u in ledger.get('models', {}).items()})
    if 'attribution' in record:
        result['attribution'] = {slug:{k:a[k] for k in ('steps','processed','firstAt','lastAt') if k in a} for slug,a in record['attribution'].items()}
    return result


def merge_summary(left, right):
    if left is None:
        return right
    if left['source'] != right['source']:
        return left if left['source'] == 'mod' else right
    if set(right['runIds']).issubset(left['runIds']):
        return left
    if set(right['runIds']) & set(left['runIds']):
        raise ValueError('부분 중복 요약은 합산할 수 없습니다')
    result = dict(left, runIds=left['runIds'] + right['runIds'],
                  startedAt=min(left['startedAt'], right['startedAt']), endedAt=max(left['endedAt'], right['endedAt']),
                  usage=sum_usage([left, right]))
    for key in ('effort','friction','requestedToolCalls'):
        result[key] = sum_counts(left.get(key, {}), right.get(key, {}))
    result['cost'] = dict(usdAtStart=0, usdAtEnd=round(left['cost']['usdAtEnd'] + right['cost']['usdAtEnd'], 12),
                          provenance='engine-ledger' if any(r['cost'].get('provenance') == 'engine-ledger' for r in (left,right)) else 'unknown',
                          estimated=left['cost'].get('estimated', False) or right['cost'].get('estimated', False))
    for key in ('tags','instructions'):
        result[key] = list(left.get(key, []))
        for item in right.get(key, []):
            if item not in result[key]:
                result[key].append(item)
    result['agents'] = {k:dict(v) for k,v in left.get('agents', {}).items()}
    for key, agent in right.get('agents', {}).items():
        if key not in result['agents']:
            result['agents'][key] = dict(agent)
        else:
            old = result['agents'][key]
            old['durationMs'] = old.get('durationMs', 0) + agent.get('durationMs', 0)
            old['firstSeenAt'] = min(old.get('firstSeenAt', right['startedAt']), agent.get('firstSeenAt', right['startedAt']))
            for field in ('model','subagentType'):
                if field not in old and field in agent:
                    old[field] = agent[field]
    if 'ledger' in left or 'ledger' in right:
        result['ledger'] = sum_counts(left.get('ledger', {}), right.get('ledger', {}))
    if 'attribution' in left or 'attribution' in right:
        result['attribution'] = {k:dict(v) for k,v in left.get('attribution', {}).items()}
        for key, value in right.get('attribution', {}).items():
            old = result['attribution'].get(key)
            result['attribution'][key] = dict(value) if old is None else dict(steps=old.get('steps',0)+value.get('steps',0), processed=old.get('processed',0)+value.get('processed',0), firstAt=min(old['firstAt'],value['firstAt']), lastAt=max(old['lastAt'],value['lastAt']))
    return result


def rollup_record(summary, slug, sid):
    return dict(summary, source='rollup', project=dict(slug=slug), sessionId=sid,
                run=dict(startedAt=summary['startedAt'], endedAt=summary['endedAt']))


def project_records(root, slugs=()):
    """출처 우선순위를 유지하면서 부분 압축된 같은 출처의 run도 보존한다."""
    root = Path(root)
    raw, folded = {}, {}
    for path in sorted((root / 'runs').glob('*/rollup-*.json')):
        slug = path.parent.name
        if slugs and slug not in slugs:
            continue
        for sid, summary in read_json(path)['sessions'].items():
            folded.setdefault((slug,sid), []).append(summary)
    for source in ('_backfill','runs'):
        pattern = '*/*/backfill.json' if source == '_backfill' else '*/*/*.json'
        for path in sorted((root / source).glob(pattern)):
            slug, sid = path.parent.parent.name, path.parent.name
            if slugs and slug not in slugs:
                continue
            record = read_json(path)
            record['source'] = 'mod' if source == 'runs' else 'backfill'
            raw.setdefault((slug,sid), []).append(record)
    selected = {}
    for key in sorted(set(raw) | set(folded)):
        rr, ff = raw.get(key, []), folded.get(key, [])
        source = 'mod' if any(r.get('source', 'mod') == 'mod' for r in rr + ff) else 'backfill'
        ff = [r for r in ff if r.get('source', 'mod') == source]
        merged = None
        for summary in ff:
            merged = merge_summary(merged, summary)
        ids = set(merged['runIds']) if merged else set()
        records = [r for r in rr if r['source'] == source and r['runId'] not in ids]
        if merged:
            records.append(rollup_record(merged, *key))
        selected[key] = records
    return selected
