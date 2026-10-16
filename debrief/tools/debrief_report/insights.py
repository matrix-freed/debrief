"""선택 통계의 명시적 허용 목록."""
import sys
from pathlib import Path
from paths import read_json, safe_enum

META_KEYS = ('session_id','start_time','duration_minutes','user_message_count','assistant_message_count','tool_errors','tool_error_categories','user_interruptions','git_commits','git_pushes','lines_added','lines_removed','files_modified','uses_task_agent')
FACET_KEYS = ('session_id','outcome','session_type','claude_helpfulness','friction_counts','user_satisfaction_counts')


def filtered(data, keys):
    out = {}
    for key in keys:
        if key not in data:
            continue
        value = data[key]
        if isinstance(value, dict):
            out[key] = {k:v for k,v in value.items() if safe_enum(k) and isinstance(v, (int,float)) and not isinstance(v, bool)}
        elif isinstance(value, (int,float,bool)) or safe_enum(value):
            out[key] = value
    return out


def insights_for(config_dirs, session_ids):
    result = {}
    for config in config_dirs:
        for sid in session_ids:
            # 경로 요소로 쓰이는 식별자는 디렉터리 탈출을 허용하지 않는다.
            if Path(sid).name != sid or '/' in sid or '\\' in sid or sid in ('.','..'):
                continue
            for folder, label, keys in (('session-meta','meta',META_KEYS), ('facets','facets',FACET_KEYS)):
                path = Path(config) / 'usage-data' / folder / (sid + '.json')
                if not path.exists():
                    continue
                try:
                    result.setdefault(sid, {})[label] = filtered(read_json(path), keys)
                except (OSError, ValueError, TypeError, AttributeError):
                    print('경고: 선택 통계를 읽지 못했습니다', file=sys.stderr)
    return result
