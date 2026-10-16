"""종료 세션만 데이터 루트에 저장한다."""
from pathlib import Path
from paths import atomic_json, millis
from transcript import parse_session


def backfill(config_dirs, root, days=30, idle_minutes=60, projects=(), exclude_sessions=(), now=None):
    from datetime import datetime, timezone
    now = millis(now) if now is not None else datetime.now(timezone.utc).timestamp() * 1000
    result = dict(found=0, closed=0, written=0, skipped=[], badLines=0, duplicateDirs=0)
    seen_dirs, seen_sessions = set(), set()
    for config in config_dirs:
        # Several config dirs may share one projects folder (symlink); count each session once.
        projects_dir = (Path(config) / 'projects').resolve()
        if projects_dir in seen_dirs:
            result['duplicateDirs'] += 1
            continue
        seen_dirs.add(projects_dir)
        for path in sorted(projects_dir.glob('*/*.jsonl')):
            if projects and path.parent.name not in projects:
                continue
            if (path.parent.name, path.stem) in seen_sessions:
                continue
            mtime = path.stat().st_mtime * 1000
            if mtime < now - days * 86400000:
                continue
            # Marked only inside the window, so an old copy in one config cannot hide a newer one.
            seen_sessions.add((path.parent.name, path.stem))
            result['found'] += 1
            ordinal = result['found']
            if path.stem in exclude_sessions:
                result['skipped'].append(dict(session=ordinal, reason='excluded'))
                continue
            record, closed, bad = parse_session(path)
            result['badLines'] += bad
            if not closed and mtime >= now - idle_minutes * 60000:
                result['skipped'].append(dict(session=ordinal, reason='open'))
                continue
            result['closed'] += 1
            target = Path(root) / '_backfill' / path.parent.name / path.stem / 'backfill.json'
            atomic_json(root, target, record)
            if target.is_file():
                result['written'] += 1
    ok = result['written'] + len(result['skipped']) == result['found'] and result['written'] == result['closed']
    return result, 0 if ok else 1
