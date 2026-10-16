"""cwd 기반 세션 프로젝트 귀속 요약."""
from collections import Counter
from pathlib import Path
from aar import optional, processed, records_for
from codex import codex_usage
from model import load_project
from paths import home
from render import render


def summary(args, root):
    sessions = [s for s in load_project(root) if s['sessionId'] == args.session]
    if not sessions or args.threshold_share < 0 or args.threshold_min < 0:
        raise ValueError('세션 또는 임계값 오류')
    profile = optional(args.profile or (Path(root)/'profile.json' if (Path(root)/'profile.json').exists() else None)) or {}
    en = profile.get('language') == 'en'
    def tr(ko,eng):
        return eng if en else ko
    def empty():
        return dict(processed=0,minutes=0,models=Counter(),external=0,externalMinutes=0,estimated=False)
    projects = {}
    for session in sessions:
        for record in records_for(root,session):
            is_backfill = session.get('source') == 'backfill'
            attribution = record.get('attribution',{}) if is_backfill else {}
            if not attribution:
                attribution = {record.get('project',{}).get('slug',session['project']['slug']):dict(processed=sum(processed(u) for mm in record.get('usage',{}).values() for u in mm.values()),firstAt=record['run']['startedAt'],lastAt=record['run'].get('endedAt',record['run']['startedAt']))}
            model_counts = {key:Counter() for key in attribution}
            ambiguous = set()
            if is_backfill:
                for step in record.get('steps',[]):
                    at = step.get('at',0)
                    candidates = [key for key,a in attribution.items() if a.get('firstAt',0) <= at <= a.get('lastAt',0)]
                    if len(candidates) == 1:
                        model_counts[candidates[0]][step.get('model','unknown')] += processed(step.get('usage') or {})
                    else:
                        ambiguous.update(candidates)
            else:
                for mm in record.get('usage',{}).values():
                    for model,usage in mm.items():
                        model_counts[next(iter(attribution))][model] += processed(usage)
            for key,a in attribution.items():
                p = projects.setdefault(key,empty())
                value = a.get('processed',0)
                p['processed'] += value
                p['minutes'] += max(0,a.get('lastAt',0)-a.get('firstAt',0))/60000
                counts = model_counts[key]
                if sum(counts.values()) != value or key in ambiguous:
                    # attribution에는 모델 키가 없다. 시간 범위가 겹치면 모델을 단정하지 않는다.
                    p['estimated'] = True
                    counts = Counter({tr('미분류 모델','Unclassified model'):value})
                p['models'].update(counts)
    total = sum(p['processed'] for p in projects.values())
    start,end = min(s['startedAt'] for s in sessions),max(s['endedAt'] for s in sessions)
    for key,p in projects.items():
        matches = codex_usage(args.codex_dir or home()/'.codex'/'sessions',[key],start,end,sessions)
        p['external'] = sum(x['tokens']['processed'] for x in matches)
        p['externalMinutes'] = sum(x['endedAt']-x['startedAt'] for x in matches)/60000
    selected = {k:p for k,p in projects.items() if p['processed']/max(1,total) >= args.threshold_share or p['minutes'] >= args.threshold_min}
    def merge(values):
        result = empty()
        for p in values:
            for k in ('processed','minutes','external','externalMinutes'):
                result[k] += p[k]
            result['models'].update(p['models'])
            result['estimated'] |= p['estimated']
        return result
    displayed = []
    if len(selected) < 2:
        displayed.append((tr('단일 프로젝트 세션','Single project session'),merge(projects.values())))
    else:
        for i,(key,p) in enumerate(selected.items(),1):
            displayed.append((profile.get('projects',{}).get(key,tr('프로젝트 ','Project ')+str(i)),p))
        others = [p for k,p in projects.items() if k not in selected]
        if others:
            displayed.append((tr('미분류','Unclassified'),merge(others)))
    cards, rows = [], []
    for name,p in displayed:
        cards.append(dict(title=name,body=tr('처리 토큰: ','Processed tokens: ')+str(p['processed'])+'\n'+tr('작업 시간(분, 겹침 포함): ','Work minutes (including overlap): ')+str(round(p['minutes'],2))+'\n'+tr('외부 처리 토큰 / 분: ','External processed tokens / minutes: ')+str(p['external'])+' / '+str(round(p['externalMinutes'],2))))
        for model,value in p['models'].items():
            cell = dict(value=value,estimated=True,basis=tr('프로젝트 귀속 시간 범위가 겹치거나 요청 기록이 불완전함','Overlapping attribution ranges or incomplete request records')) if p['estimated'] else value
            rows.append([name,model,cell])
    data = dict(title=tr('세션 서머리','Session summary'),language='en' if en else 'ko',axis=dict(t0=start,t1=end,tickMs=600000,bucketMs=600000),sections=[dict(title=tr('프로젝트별 귀속','Project attribution'),cards=cards,headers=[tr('프로젝트','Project'),tr('모델','Model'),tr('처리 토큰','Processed tokens')],rows=rows,text=tr('cwd 기반만 집계한다. 도구 입력 경로 기반 귀속은 하지 않는다. 작업 시간은 겹침을 포함한다. attribution에 모델 키가 없어 시간 범위가 겹치는 요청의 모델은 미분류 추정으로 표시한다.','Only cwd attribution is available. Tool input paths are excluded. Duration includes overlap. Attribution lacks model keys; overlapping request ranges use an estimated unclassified model.'))])
    # G2: the summary carries an auxiliary / compaction cell (engine ledger minus request sum, backfill only).
    auxiliary, measured, lag = 0, False, False
    for session in sessions:
        if session.get('source') != 'backfill':
            continue
        for record in records_for(root,session):
            for model,u in record.get('ledger',{}).get('models',{}).items():
                measured = True
                delta = processed(u)-sum(processed(mm.get(model,{})) for mm in record.get('usage',{}).values())
                auxiliary += max(0,delta)
                lag |= delta < 0
    aux = dict(value=auxiliary,estimated=True,basis=tr('cost-state 장부 - transcript 요청 합','cost-state ledger minus transcript request sum')) if measured else tr('측정 안 됨','Not measured')
    data['sections'].append(dict(title=tr('보조·압축','Auxiliary / compaction'),headers=[tr('보조·압축 처리 토큰','Auxiliary / compaction processed tokens'),tr('장부 상태','Ledger state')],rows=[[aux,tr('장부 지연','Ledger lag') if lag else '']]))
    render(data,args.out)
    return dict(output=str(args.out),processed=total,projects=len(selected)),0
