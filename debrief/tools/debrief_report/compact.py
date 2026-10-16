"""월별 메타데이터 요약과 바이트 검증을 거친 원본 보관."""
import io
import json
import math
import os
import re
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from model import merge_summary, summary_record
from paths import atomic_json, millis, read_json


def inside(root, path):
    if root.resolve() not in path.resolve().parents or path.is_symlink():
        raise ValueError('루트 밖 경로 또는 링크')


def archive(root, path, entries):
    inside(root, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    members = {}
    if path.exists():
        with tarfile.open(path, 'r:gz') as old:
            for member in old:
                if not member.isfile():
                    raise ValueError('일반 파일이 아닌 아카이브 멤버')
                members[member.name] = old.extractfile(member).read()
    members.update(entries)
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(path.parent), delete=False) as temp:
            name = temp.name
        with tarfile.open(name, 'w:gz') as out:
            for key, data in sorted(members.items()):
                info = tarfile.TarInfo(key)
                info.size = len(data)
                out.addfile(info, io.BytesIO(data))
        with tarfile.open(name, 'r:gz') as check:
            if check.getnames() != sorted(members):
                raise ValueError('아카이브 멤버 불일치')
            for key, data in members.items():
                if check.extractfile(key).read() != data:
                    raise ValueError('아카이브 바이트 불일치')
        os.replace(name, path)
        # 교체된 최종 파일도 다시 열어 확인한 뒤에만 호출자가 원본을 지운다.
        with tarfile.open(path, 'r:gz') as check:
            for key, data in entries.items():
                if check.extractfile(key).read() != data:
                    raise ValueError('아카이브 바이트 불일치')
    finally:
        if name and Path(name).exists():
            Path(name).unlink()


def compact(root, days=30, now=None, dry_run=False, delete_before=None, yes=False):
    root = Path(root)
    if delete_before is not None:
        if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', delete_before):
            raise ValueError('월 형식 오류')
        paths = [p for p in sorted((root / 'archive').glob('*.tar.gz'))
                 if re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])\.tar\.gz', p.name) and p.name[:7] < delete_before]
        for path in paths:
            inside(root, path)
        if yes and not dry_run:
            for path in paths:
                path.unlink()
        return dict(archives=[str(p) for p in paths], deleted=len(paths) if yes and not dry_run else 0), 0 if yes else 2
    if not math.isfinite(days) or days <= 0:
        raise ValueError('days는 양수여야 합니다')
    now = millis(now) if now is not None else datetime.now(timezone.utc).timestamp() * 1000
    groups = {}
    candidates = sorted((root / 'runs').glob('*/*/*.json')) + sorted((root / '_backfill').glob('*/*/backfill.json'))
    for path in candidates:
        inside(root, path)
        raw = path.read_bytes()
        record = json.loads(raw)
        run = record['run']
        closed = run.get('endedAt') is not None
        at = run['endedAt'] if closed else run.get('lastCheckpointAt', run['startedAt'])
        if at >= now - days * (1 if closed else 2) * 86400000:
            continue
        month = datetime.fromtimestamp(at / 1000, timezone.utc).strftime('%Y-%m')
        slug, sid = path.parent.parent.name, path.parent.name
        record['source'] = 'mod' if path.relative_to(root).parts[0] == 'runs' else 'backfill'
        record['run'] = dict(run, endedAt=at)
        groups.setdefault(month, []).append((path, raw, slug, sid, record))
    result = dict(targets=sum(len(g) for g in groups.values()), months=[dict(month=m, sessions=len({(x[2],x[3]) for x in g}), archive=str(root / 'archive' / (m + '.tar.gz'))) for m,g in sorted(groups.items())], dryRun=dry_run)
    if dry_run:
        return result, 0
    try:
        for month, group in sorted(groups.items()):
            rollups = {}
            for path, raw, slug, sid, record in group:
                target = root / 'runs' / slug / ('rollup-' + month + '.json')
                inside(root, target)
                if target not in rollups:
                    rollups[target] = read_json(target) if target.exists() else dict(version=1, slug=slug, month=month, sessions={})
                sessions = rollups[target]['sessions']
                sessions[sid] = merge_summary(sessions.get(sid), summary_record(record))
            entries = {p.relative_to(root).as_posix(): raw for p,raw,_,_,_ in group}
            archive(root, root / 'archive' / (month + '.tar.gz'), entries)
            for path, raw, _, _, _ in group:
                if path.read_bytes() != raw:
                    raise ValueError('압축 중 원본 변경')
            for path, data in rollups.items():
                atomic_json(root, path, data)
            for path, _, _, _, _ in group:
                path.unlink()
                if not any(path.parent.iterdir()):
                    path.parent.rmdir()
    except (tarfile.TarError, EOFError) as exc:
        raise ValueError('아카이브 오류') from exc
    return result, 0
