"""공통 시간, 경로와 원자적 저장."""
import json
import math
import os
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


def millis(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def slug_of(value):
    return re.sub(r'[^A-Za-z0-9]', '-', value)


def home():
    return Path(os.environ.get('HOME') or os.environ.get('USERPROFILE') or Path.home())


def atomic_json(root, path, data):
    root, path = Path(root).resolve(), Path(path)
    if root not in path.resolve().parents:
        raise ValueError('출력 경로가 루트 밖입니다')
    path.parent.mkdir(parents=True, exist_ok=True)
    if root not in path.resolve().parents:
        raise ValueError('출력 경로가 루트 밖입니다')
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=str(path.parent), delete=False) as handle:
            name = handle.name
            json.dump(data, handle, ensure_ascii=False, allow_nan=False)
            handle.write('\n')
        os.replace(name, path)
    finally:
        if name and Path(name).exists():
            Path(name).unlink()


def read_json(path):
    with Path(path).open(encoding='utf-8') as handle:
        return json.load(handle)


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0


def safe_enum(value, limit=64):
    return isinstance(value, str) and len(value) <= limit and all(unicodedata.category(c) != 'Cc' for c in value)
