"""줄 단위 메타데이터 추출. 본문과 원문 경로는 보관하지 않는다."""
import json
from pathlib import Path
from paths import millis, number, read_json, safe_enum, slug_of

COUNTERS = ('in', 'out', 'cacheRead', 'cacheWrite')
USAGE_KEYS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
LEDGER_KEYS = ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD')


def parse_session(path):
    path = Path(path)
    requests, tools, groups, times, loop_times = {}, {}, {}, [], {}
    bad = 0
    surface = None
    closed = False
    friction = dict(aborted=0, toolErrors=0, rejected=0, compactions=0)
    # Timestamps of compaction boundaries, for the representative session timeline.
    events = []
    files = [(path, 'main')] + [(p, p.stem[6:]) for p in sorted((path.parent / path.stem / 'subagents').glob('agent-*.jsonl'))]
    for file, default_loop in files:
        with file.open(encoding='utf-8', errors='replace') as handle:
            for line in handle:
                try:
                    obj = json.loads(line)
                    if not isinstance(obj, dict):
                        raise ValueError()
                except ValueError:
                    bad += 1
                    continue
                kind = obj.get('type')
                if kind not in ('assistant', 'user', 'system', 'cost-state'):
                    continue
                cwd_slug = slug_of(obj.pop('cwd')) if isinstance(obj.get('cwd'), str) else None
                loop = default_loop
                if default_loop == 'main' and obj.get('isSidechain') and obj.get('agentId'):
                    loop = obj['agentId']
                try:
                    at = millis(obj.get('timestamp'))
                except (ValueError, TypeError):
                    at = None
                if at is not None:
                    times[:] = [min(times[0], at), max(times[-1], at)] if times else [at, at]
                    bounds = loop_times.setdefault(loop, [at, at])
                    bounds[:] = [min(bounds[0], at), max(bounds[1], at)]
                entry = obj.get('entrypoint')
                if surface is None and safe_enum(entry, 32) and entry and not any(c.isspace() for c in entry):
                    surface = entry
                if kind == 'cost-state':
                    if default_loop == 'main':
                        closed = True
                    models = {}
                    for model, usage in (obj.get('modelUsage') or {}).items():
                        models[model] = {k: number(usage.get(v)) for k, v in zip(COUNTERS + ('usd',), LEDGER_KEYS)}
                    groups[obj.get('startTime')] = (number(obj.get('totalCostUSD')), models)
                elif kind == 'assistant':
                    if default_loop == 'main':
                        closed = False
                    message = obj.get('message') or {}
                    key = (obj.get('requestId'), message.get('id'))
                    if key == (None, None):
                        key = ('unkeyed', len(requests), str(file))
                    previous = requests.get(key)
                    usage = message.get('usage')
                    step = dict(loop=previous['loop'] if previous else loop, turnId='', model=message.get('model') or 'unknown', stopReason=message.get('stop_reason'), usage={k: number(usage.get(v)) for k, v in zip(COUNTERS, USAGE_KEYS)} if isinstance(usage, dict) else None, at=at or 0)
                    if safe_enum(obj.get('effort'), 32) and obj.get('effort'):
                        step['effort'] = obj['effort']
                    step['_slug'] = cwd_slug
                    step['_aborted'] = bool(obj.get('isAbortedMidStream'))
                    requests[key] = step
                    content = message.get('content')
                    for block in content if isinstance(content, list) else []:
                        if isinstance(block, dict) and block.get('type') == 'tool_use':
                            tool_id = block.get('id')
                            if tool_id is None:
                                tool_id = ('unkeyed', len(tools))
                            tools.setdefault(tool_id, (step['loop'], block.get('name') or 'unknown'))
                elif kind == 'user':
                    friction['rejected'] += int('toolDenialKind' in obj)
                    content = (obj.get('message') or {}).get('content')
                    friction['toolErrors'] += sum(1 for b in (content if isinstance(content, list) else []) if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error') is True)
                elif kind == 'system':
                    if obj.get('subtype') == 'compact_boundary':
                        friction['compactions'] += 1
                        if at is not None:
                            events.append(dict(kind='compaction', at=at))
    usage, effort, attribution, steps, requested = {}, {}, {}, [], {}
    for index, request in enumerate(requests.values()):
        step = dict(request)
        location = step.pop('_slug')
        if step.pop('_aborted'):
            friction['aborted'] += 1
            step['aborted'] = True
        loop, model, u = step['loop'], step['model'], step['usage']
        acc = usage.setdefault(loop, {}).setdefault(model, dict.fromkeys(COUNTERS + ('steps', 'nullUsageSteps'), 0))
        acc['steps'] += 1
        acc['nullUsageSteps'] += int(u is None)
        for k in COUNTERS:
            acc[k] += (u or {}).get(k, 0)
        counts = effort.setdefault(model, {})
        level = step.get('effort', 'none')
        counts[level] = counts.get(level, 0) + 1
        if location:
            a = attribution.setdefault(location, dict(steps=0, processed=0, firstAt=step['at'], lastAt=step['at']))
            a['steps'] += 1
            a['processed'] += sum((u or {}).get(k, 0) for k in ('in', 'out', 'cacheWrite'))
            a['firstAt'], a['lastAt'] = min(a['firstAt'], step['at']), max(a['lastAt'], step['at'])
        step['index'] = index
        steps.append(step)
    for loop, name in tools.values():
        counts = requested.setdefault(loop, {})
        counts[name] = counts.get(name, 0) + 1
    agents = {}
    for loop, bounds in loop_times.items():
        if loop == 'main':
            continue
        models = usage.get(loop, {})
        agent = dict(resumed=False, spawnAttempts=1, turns=0, firstSeenAt=bounds[0], durationMs=bounds[1]-bounds[0], seen=dict(start=0, steps=sum(u['steps'] for u in models.values()), complete=0, spawn=0))
        if models:
            agent['model'] = next(iter(models))
        meta = path.parent / path.stem / 'subagents' / ('agent-' + loop + '.meta.json')
        try:
            data = read_json(meta)
            if isinstance(data.get('agentType'), str):
                agent['subagentType'] = data['agentType']
        except (OSError, ValueError, TypeError):
            pass
        agents[loop] = agent
    cost = dict(provenance='unknown')
    ledger = None
    if groups:
        cost = dict(usdAtStart=0, usdAtEnd=round(sum(g[0] for g in groups.values()), 12), provenance='engine-ledger')
        ledger = dict(groups=len(groups), models={})
        for _, models in groups.values():
            for model, values in models.items():
                acc = ledger['models'].setdefault(model, dict.fromkeys(COUNTERS + ('usd',), 0))
                for k, value in values.items():
                    acc[k] = round(acc[k] + value, 12)
    record = dict(schema=3, recorder='debrief-report/0.1.0', engine='transcript', source='backfill', project=dict(slug=path.parent.name), sessionId=path.stem, runId='backfill', run=dict(startedAt=min(times) if times else 0, endedAt=max(times) if times else 0, endReason='closed' if closed else 'idle', surface=surface, isInteractive=surface == 'cli', reloads=0, lastCheckpointAt=max(times) if times else 0, coverage='partial' if bad else 'complete', dropped=dict(steps=max(0, len(steps)-2000), turns=0, agents=0)), usage=usage, effort=effort, steps=steps[-2000:], turns=[], openTurns={}, cost=cost, context={}, agents=agents, spawnDenied=0, workflowRuns=[], requestedToolCalls=requested, serverToolUses={}, toolCalls=dict(main=sum(v for v in requested.get('main', {}).values()), agent=sum(sum(c.values()) for l,c in requested.items() if l != 'main'), isError=friction['toolErrors'], denied=0, reentry={}), classic=dict(seen=False, sessionStartSources=[], postToolUseFailures=0, interrupts=0, compactions=0), friction=friction, skills={}, commands={}, messaging=dict(sent={}, received={}), delegation=dict(external={}, directives={}), tags=[], instructions=[], profileSource='default', writes=dict(ok=1, failed=0), attribution=attribution, events=sorted(events, key=lambda e: e['at']))
    if ledger is not None:
        record['ledger'] = ledger
    return record, closed, bad
