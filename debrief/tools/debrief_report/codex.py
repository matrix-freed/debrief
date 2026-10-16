"""외부 실행 사용량. 기본 수집 사용량과 별도 유지한다."""
import json
import sys
from pathlib import Path
from paths import millis, number, read_json, slug_of

# 호출 표식은 데이터로 두고 코어의 분기 상수에 이름을 넣지 않는다.
DEFAULT_ORIGINATORS = tuple(read_json(Path(__file__).with_name('defaults.json'))['externalOriginators'])


def pick(sessions, start):
    """Pick the session that most likely started an external run.

    1. a session whose declared external-agent window (externalWindows) holds the start,
    2. else a session whose interval holds the start, latest start first,
    3. else a session that ended at most 5 minutes before the start, nearest end first.
    """
    delegated = [s for s in sessions if any(a - 60000 <= start <= b + 60000 for a, b in s.get('externalWindows', ()))]
    if delegated:
        return max(delegated, key=lambda s: s['startedAt'])
    containing = [s for s in sessions if s['startedAt'] <= start <= s['endedAt']]
    if containing:
        return max(containing, key=lambda s: s['startedAt'])
    near = [s for s in sessions if s['endedAt'] < start <= s['endedAt'] + 300000]
    return min(near, key=lambda s: start - s['endedAt']) if near else None


def codex_usage(codex_dir, slugs=(), t0=None, t1=None, sessions=(), external_originators=DEFAULT_ORIGINATORS):
    result = []
    for path in sorted(Path(codex_dir).rglob('rollout-*.jsonl')):
        requests, times, originator, project, model, effort = {}, [], None, None, None, None
        try:
            with path.open(encoding='utf-8') as handle:
                for line in handle:
                    try:
                        obj = json.loads(line)
                        kind, payload = obj.get('type'), obj.get('payload') or {}
                        if kind not in ('session_meta', 'turn_context', 'token_usage_record', 'event_msg'):
                            continue
                        if kind == 'event_msg' and payload.get('type') not in ('task_started', 'task_complete'):
                            continue
                        at = millis(obj.get('timestamp'))
                        if at is not None:
                            times[:] = [min(times[0], at), max(times[-1], at)] if times else [at, at]
                        if kind == 'session_meta':
                            project = slug_of(payload.pop('cwd')) if isinstance(payload.get('cwd'), str) else None
                            originator = payload.get('originator')
                        elif kind == 'turn_context':
                            model, effort = payload.get('model'), payload.get('effort')
                        elif kind == 'token_usage_record':
                            key = payload.get('response_id')
                            if key is None:
                                key = ('unkeyed', len(requests))
                            usage = payload.get('usage') or {}
                            requests[key] = {k: number(usage.get(v)) for k,v in zip(('input','cached','output','reasoning'), ('input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'))}
                    except (ValueError, TypeError, AttributeError):
                        print('경고: 선택 로그의 손상된 줄을 건너뜁니다', file=sys.stderr)
        except (OSError, UnicodeError):
            print('경고: 선택 로그를 읽지 못했습니다', file=sys.stderr)
            continue
        if not times or not project or (slugs and not any(project == s or project.startswith(s + '-') for s in slugs)):
            continue
        start, end = min(times), max(times)
        if (t0 is not None and end < millis(t0)) or (t1 is not None and start > millis(t1)):
            continue
        totals = {k: sum(u[k] for u in requests.values()) for k in ('input','cached','output','reasoning')}
        totals['processed'] = totals['input'] - totals['cached'] + totals['output']
        match = pick(sessions, start) if originator in external_originators else None
        run = dict(startedAt=start, endedAt=end, model=model, originator=originator, requests=len(requests), tokens=totals, matchedSession=match.get('index') if match else None)
        if effort is not None:
            run['effort'] = effort
        result.append(run)
    return result
