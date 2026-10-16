"""개선 장부와 독립 실행 가능한 적용 프롬프트."""
import hashlib
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from paths import atomic_json, read_json
from export import safe_text

STATUSES = ('proposed', 'applied', 'verified', 'dropped')

def normalize(title):
    return ' '.join(re.sub(r'[^\w\s]|_', '', title.lower()).split())

def prompt(item, language='ko'):
    d = dict.fromkeys(('what','where','lever','target','how','verify','metric'), '')
    d.update(item)
    d['evidence'] = ', '.join(item.get('evidence', []))
    if language == 'en':
        return ("[debrief improvement application - ledger {id}]\nThis prompt runs without AAR context. Work only from the following.\nWhat: {what}\nWhere: {where} (lever: {lever}, target: {target})\nHow: {how}\nEvidence: {evidence}\nVerify: {verify} - metric: {metric}\nWhen finished: set ledger item {id} to applied (`/debrief ledger set {id} applied` or report program `ledger set {id} applied`). Use verified after verification.\nDo not change files outside scope. Ask the user before making decisions requiring judgment.").format(**d)
    return ("[debrief 개선 적용 - 장부 {id}]\n이 프롬프트는 AAR 맥락 없이 실행된다. 아래만 근거로 작업한다.\n무엇을: {what}\n어디에: {where} (레버: {lever}, 대상: {target})\n어떻게: {how}\n근거: {evidence}\n검증: {verify} - 측정 지표: {metric}\n끝나면: debrief 장부 항목 {id}의 상태를 applied로 바꾼다(`/debrief ledger set {id} applied` 또는 리포트 프로그램 `ledger set {id} applied`). 검증까지 확인했으면 verified.\n범위 밖 파일은 바꾸지 않는다. 판단이 필요한 지점이 있으면 바꾸기 전에 사용자에게 확인한다.").format(**d)

def read_ledger(root):
    path = Path(root) / 'ledger.json'
    return read_json(path) if path.exists() else dict(version=1, items=[])

def register(root, improvements, project, language='ko', write=True):
    ledger = read_ledger(root)
    now = datetime.now(timezone.utc)
    stamp = now.isoformat()
    result = []
    for source in improvements:
        source = safe_text(source)
        title = source.get('title', '')
        norm = normalize(title)
        existing = next((x for x in ledger['items'] if normalize(x.get('title', '')) == norm), None)
        ident = source.get('id') or (existing or {}).get('id') or 'i-' + now.strftime('%Y%m%d') + '-' + hashlib.sha1(norm.encode()).hexdigest()[:6]
        old = next((x for x in ledger['items'] if x['id'] == ident), {})
        item = {k: source.get(k, '') for k in ('title','lever','target','metric')}
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,63}',ident):
            raise ValueError('잘못된 장부 ID')
        item.update(id=ident, project=safe_text(project), status=old.get('status', 'proposed'), evidence=source.get('evidence', []), createdAt=old.get('createdAt', stamp), updatedAt=stamp)
        item['recurrenceOf'] = [x['id'] for x in ledger['items'] if x['id'] != ident and SequenceMatcher(None, norm, normalize(x.get('title', ''))).ratio() >= .6]
        item['applyPrompt'] = prompt(dict(source, id=ident), language)
        if old:
            ledger['items'][ledger['items'].index(old)] = item
        else:
            ledger['items'].append(item)
        result.append(dict(item, recurrence=[x['id'] + '(' + x['status'] + ')' for x in ledger['items'] if x['id'] in item['recurrenceOf']]))
    if write:
        atomic_json(root, Path(root) / 'ledger.json', ledger)
    return result

def command(root, action, ident=None, status=None):
    data = read_ledger(root)
    if action == 'list':
        return dict(items=[x for x in data['items'] if not status or x['status'] == status]), 0
    item = next((x for x in data['items'] if x['id'] == ident), None)
    if item is None:
        return dict(error='없는 장부 ID'), 2
    item.update(status=status, updatedAt=datetime.now(timezone.utc).isoformat())
    atomic_json(root, Path(root) / 'ledger.json', data)
    return dict(item=item), 0
