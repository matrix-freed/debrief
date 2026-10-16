"""집계 메타데이터로 만드는 프로젝트 AAR."""
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from codex import codex_usage
from insights import insights_for
from ledger import register
from model import load_project, project_records
from paths import home, read_json
from render import render
from aar_visuals import prepare


def optional(path):
    if path is None:
        return None
    try:
        data = read_json(path)
        if not isinstance(data, dict):
            raise ValueError()
        for key in ('cards','improvements'):
            if key in data and (not isinstance(data[key],list) or any(not isinstance(x,dict) for x in data[key])):
                raise ValueError()
        for key in ('projects','lanes','hypotheses'):
            if key in data and not isinstance(data[key],dict):
                raise ValueError()
        for key in ('topModels','externalOriginators','externalAgentTypes'):
            if key in data and (not isinstance(data[key],list) or any(not isinstance(x,str) for x in data[key])):
                raise ValueError()
        for pattern in data.get('topModels',[]):
            re.compile(pattern)
        for key in ('projects','lanes'):
            if any(not isinstance(v,str) for v in data.get(key,{}).values()):
                raise ValueError()
        for item in data.get('improvements',[]):
            if not item.get('title') or item.get('lever') not in ('template','skill','hook','setting','statusline','instruction'):
                raise ValueError()
            if item.get('id') and not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,63}',item['id']):
                raise ValueError()
        for item in data.get('cards',[]) + data.get('improvements',[]):
            if any(not isinstance(v,str) for k,v in item.items() if k != 'evidence'):
                raise ValueError()
            if 'evidence' in item and (not isinstance(item['evidence'],list) or any(not isinstance(x,str) for x in item['evidence'])):
                raise ValueError()
        return data
    except (OSError, ValueError, TypeError, re.error):
        print('경고: 선택 입력을 읽지 못했습니다', file=sys.stderr)
        return None


def zone(value=None):
    if value is None:
        return datetime.now().astimezone().tzinfo
    if re.fullmatch(r'[+-]\d\d:\d\d', value):
        hours, minutes = map(int, value[1:].split(':'))
        if hours > 23 or minutes > 59:
            raise ValueError('시간대 오류')
        return timezone((1 if value[0] == '+' else -1) * timedelta(hours=hours, minutes=minutes))
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(value)
    except (ImportError, KeyError):
        # IANA 데이터가 없는 환경에서는 현재 로컬 고정 오프셋을 쓴다.
        print('경고: 시간대 데이터 없음, 로컬 고정 오프셋 사용', file=sys.stderr)
        return datetime.now().astimezone().tzinfo


def records_for(root, session):
    return project_records(root, [session['project']['slug']]).get((session['project']['slug'], session['sessionId']), [])


def processed(u):
    return sum(u.get(k, 0) for k in ('in','out','cacheWrite'))


def build_report_data(root, slugs, configs=(), title=None, t0=None, t1=None, cards=None, profile=None, codex_dir=None, tz=None, no_ledger=False):
    sessions = load_project(root, slugs, t0, t1)
    if not slugs or not sessions:
        raise ValueError('프로젝트 또는 세션 없음')
    profile = profile or None
    en = bool(profile and profile.get('language') == 'en')
    language = 'en' if en else 'ko'
    def tr(ko, eng):
        return eng if en else ko
    stamp_zone = zone(tz)
    def clock(t):
        return datetime.fromtimestamp(t/1000, stamp_zone).isoformat(timespec='minutes')
    cards = cards or {}
    title = title or cards.get('title') or tr('프로젝트 AAR', 'Project AAR')
    start, end = min(s['startedAt'] for s in sessions), max(s['endedAt'] for s in sessions)
    duration = end-start
    tick = 600000 if duration < 7200000 else 3600000 if duration < 86400000 else 86400000
    def ticks(a,b,step):
        first = int(a//step+1)*step
        return [dict(at=t,label=clock(t)) for t in range(first,int(b)+1,step)]
    data = dict(title=title, language=language, axis=dict(t0=start,t1=end,tickMs=tick,bucketMs=tick), ticks=ticks(start,end,tick), sections=[])
    def section(ko, eng, **kw):
        s = dict(title=tr(ko, eng), **kw)
        data['sections'].append(s)
        return s
    sources = Counter(s.get('source') or 'mod' for s in sessions)
    section('기록 개요', 'Report overview', text=clock(start)+' ~ '+clock(end)+' / '+str(len(sessions))+' '+tr('세션','sessions')+' / '+', '.join(k+' '+str(v) for k,v in sources.items()))
    loaded = project_records(root, slugs)
    records = {s['index']: loaded.get((s['project']['slug'], s['sessionId']), []) for s in sessions}
    # Agent windows of declared external agent types steer external-run matching (codex.pick).
    external_types = set((profile or {}).get('externalAgentTypes', []))
    for s in sessions:
        s['externalWindows'] = [(a.get('firstSeenAt', s['startedAt']), a.get('firstSeenAt', s['startedAt']) + a.get('durationMs', 0)) for r in records[s['index']] for a in r.get('agents', {}).values() if a.get('subagentType') in external_types]
    runs = codex_usage(codex_dir or home()/'.codex'/'sessions', slugs, t0 if t0 is not None else start, t1 if t1 is not None else end, sessions, **({'external_originators':profile['externalOriginators']} if profile and 'externalOriginators' in profile else {}))
    insight = insights_for(configs, [s['sessionId'] for s in sessions])
    has_cost = any(r.get('cost', {}).get('provenance') == 'engine-ledger' or 'usdAtEnd' in r.get('cost', {}) for rr in records.values() for r in rr)
    totals = {k:round(sum(s[k] for s in sessions),12) for k in ('processed','cacheRead','requests','usdTotal')}
    agent_count = sum(len({a for r in rr for a in r.get('agents', {})}) for rr in records.values())
    section('엔진 장부(API 환산)' if has_cost else '처리 토큰', 'Engine ledger (API equivalent)' if has_cost else 'Processed tokens', kind='hero', text=('$%.2f'%totals['usdTotal'] if has_cost else format(totals['processed'], ',')), cards=[dict(title=tr(k,e),body=str(v)) for k,e,v in [('처리 토큰','Processed tokens',totals['processed']),('캐시 읽기','Cache read',totals['cacheRead']),('요청 수','Requests',totals['requests']),('세션 수','Sessions',len(sessions)),('서브에이전트 수','Subagents',agent_count),('작업 시간(분, 겹침 포함)','Work minutes (including overlap)',round(sum(s['endedAt']-s['startedAt'] for s in sessions)/60000,2)),('외부 처리 토큰','External processed tokens',sum(x['tokens']['processed'] for x in runs))]], rows=[[tr('세션 누적, run별 차의 합','Session cumulative, sum of run deltas')+(tr(' / 비용 누락·음수 차이를 0으로 처리한 세션 ',' / sessions with missing or negative cost deltas counted as zero: ')+str(sum(1 for s in sessions if s.get('estimated')))+tr('개','') if has_cost and any(s.get('estimated') for s in sessions) else '')]])
    if not runs:
        data['sections'][1]['cards'].pop()
    ordered = [next((c for c in cards.get('cards',[]) if c.get('k') == k), None) for k in ('plan','actual','gap','improve')]
    section('계획 / 실제 / 차이 / 개선', 'Plan / Actual / Gap / Improvement', cards=[{k:c[k] for k in ('title','body','evidence') if k in c} if c else dict(title=tr(ko,eng),body=tr('작성되지 않음','Not written')) for c,ko,eng in zip(ordered,('계획','실제','차이','개선'),('Plan','Actual','Gap','Improvement'))])
    improvements = register(root, cards.get('improvements', []), title, language, not no_ledger) if cards.get('improvements') else []
    section('개선 항목','Improvements', cards=[dict(title=i['title'],body=' / '.join([i['lever'],i['target'],i['metric'],i['id'],i['status']])+('\n'+tr('재발 후보: ','Recurrence candidates: ')+', '.join(i['recurrence']) if i['recurrence'] else ''),evidence=i['evidence'],prompt=i['applyPrompt']) for i in improvements])
    models, loop_rows, efforts, tools = Counter(), [], Counter(), Counter()
    lanes, timeline, friction, ledger_rows, fingerprint, hypotheses = [], [], [], [], [], []
    declarations = defaultdict(lambda: [0,0])
    previous = {}
    representative = max(sessions,key=lambda s:s['processed'])['index']
    for s in sessions:
        si, rr = s['index'], records[s['index']]
        agents = {}
        for r in rr:
            agents.update(r.get('agents',{}))
        aliases = {key:si+'-A'+str(i) for i,key in enumerate(agents,1)}
        main_model = max(((m,processed(u)) for m,u in s['usage'].get('main',{}).items()),key=lambda p:p[1],default=('',0))[0]
        lanes.append(dict(label=si+' main',start=s['startedAt'],end=s['endedAt'],color=main_model))
        for key,a in agents.items():
            lanes.append(dict(label=aliases[key],start=a.get('firstSeenAt',s['startedAt']),end=a.get('firstSeenAt',s['startedAt'])+a.get('durationMs',0),color=a.get('model','')))
            kind = a.get('subagentType',tr('미선언','Undeclared'))
            declarations[kind][0] += a.get('spawnAttempts',1)
            declarations[kind][1] += sum(processed(u) for u in s['usage'].get(key,{}).values())
        auxiliary, lag = 0, False
        any_ledger = False
        for r in rr:
            for loop, mm in r.get('usage',{}).items():
                for model,u in mm.items():
                    p = processed(u)
                    models[model] += p
                    label = 'main' if loop == 'main' else tr('agent 합','agent total')
                    loop_rows.append([si,model,label,u.get('in',0),u.get('out',0),u.get('cacheRead',0),u.get('cacheWrite',0),u.get('steps',0)-u.get('nullUsageSteps',0),p])
                    if loop != 'main':
                        loop_rows.append([si,model,agents.get(loop,{}).get('subagentType',tr('미선언','Undeclared')),u.get('in',0),u.get('out',0),u.get('cacheRead',0),u.get('cacheWrite',0),u.get('steps',0)-u.get('nullUsageSteps',0),p])
            for mm in r.get('effort',{}).values():
                efforts.update(mm)
            for counts in r.get('requestedToolCalls',{}).values():
                tools.update(counts)
            for model,u in r.get('ledger',{}).get('models',{}).items():
                any_ledger = True
                request = sum(processed(mm.get(model,{})) for mm in r.get('usage',{}).values())
                delta = processed(u)-request
                auxiliary += max(0,delta)
                lag |= delta < 0
            if si == representative:
                for step in r.get('steps',[]):
                    at = step.get('at',s['startedAt'])
                    timeline.append(dict(label=aliases.get(step.get('loop'),si+' main'),start=at,end=at+1000,color=step.get('model','')))
                tags = sorted([t for t in r.get('tags',[]) if isinstance(t,dict) and isinstance(t.get('at'),(int,float))],key=lambda t:t['at'])
                for j,tag in enumerate(tags):
                    timeline.append(dict(label=tag.get('label',tag.get('name','tag')),start=tag['at'],end=tags[j+1]['at'] if j+1<len(tags) else s['endedAt'],color='--ext'))
            for inst in r.get('instructions',[]):
                key, value = inst.get('pathHash',''),inst.get('contentHash','')
                if key in previous and previous[key] != value:
                    fingerprint.append([key[:8],value[:8],si])
                previous[key] = value
        back = s.get('source') == 'backfill'
        aux = dict(value=auxiliary,estimated=True,basis=tr('cost-state 장부 - transcript 요청 합','cost-state ledger minus transcript request sum')) if back and any_ledger else tr('측정 안 됨','Not measured')
        cost = '$%.2f'%s['usdTotal']
        if s.get('estimated'):
            cost = dict(value=cost,estimated=True,basis=tr('비용 누락 또는 음수 차이는 0','Missing or negative cost deltas count as zero'))
        ledger_rows.append([si,cost,aux,tr('장부 지연','Ledger lag') if lag else ''])
        counts = {k:sum(r.get('friction',{}).get(k,0) or 0 for r in rr) if any(k in r.get('friction',{}) for r in rr) else None for k in ('aborted','toolErrors','rejected','compactions')}
        ins = insight.get(s['sessionId'],{}).get('facets',{})
        friction.append([si]+list(counts.values())+[str(ins['friction_counts']) if ins.get('friction_counts') else '',ins.get('outcome','')])
        standard = (profile or {}).get('thresholdStyle') == 'standard'
        overrides = (profile or {}).get('hypotheses',{})
        def threshold(ident,key,default):
            item = overrides.get(ident,{})
            value = item.get(key,default) if isinstance(item,dict) else default
            return value if isinstance(value,(int,float)) and not isinstance(value,bool) else default
        mins = threshold('long-no-subagent','minutes',overrides.get('longSessionMinutes',60 if standard else 120))
        if (s['endedAt']-s['startedAt'])/60000 >= mins and not agents:
            hypotheses.append(dict(title=tr('긴 세션의 분담 가능성','Potential work sharing in a long session'),body=si+' / '+str(round((s['endedAt']-s['startedAt'])/60000))+tr('분. 분담할 작업이 있었는지 확인해 볼 수 있다',' minutes. Consider whether work could be shared.'),badge=tr('가설','Hypothesis')))
        req = s['requests']
        by_req = Counter()
        for mm in s['usage'].values():
            for m,u in mm.items():
                by_req[m] += u.get('steps',0)-u.get('nullUsageSteps',0)
        patterns = (profile or {}).get('topModels',[])
        top = sum(v for m,v in by_req.items() if any(re.search(p,m) for p in patterns)) if patterns else max(by_req.values(), default=0)
        if req >= threshold('single-top-model','requests',20 if standard else 50) and top/max(1,req) >= threshold('single-top-model','share',.9 if standard else .98):
            hypotheses.append(dict(title=tr('모델 요청 집중','Concentrated model requests'),body=si+' / '+str(top)+' / '+str(req)+' '+tr('요청. 단순 작업을 다른 모델로 나눌 여지가 있는지 볼 수 있다','requests. Consider sharing simpler work across models.'),badge=tr('가설','Hypothesis')))
        calls = sum(sum(c.values()) for r in rr for c in r.get('requestedToolCalls',{}).values())
        if calls >= threshold('tool-error-rate','calls',10 if standard else 20) and (counts['toolErrors'] or 0)/max(1,calls) > threshold('tool-error-rate','rate',.08 if standard else .1):
            hypotheses.append(dict(title=tr('도구 오류 비율','Tool error rate'),body=si+' / '+str(counts['toolErrors'])+' / '+str(calls)+' '+tr('반복되는 오류 유형이 있는지 확인해 볼 수 있다','Consider recurring error categories.'),badge=tr('가설','Hypothesis')))
    colors = {m:'--m'+str(i%6+1) for i,(m,_) in enumerate(models.most_common())}
    for row in lanes+timeline:
        row['color'] = colors.get(row['color'],'--ext')
    section('모델별 처리 토큰 / 모델과 루프','Processed tokens by model / loop',chart=[dict(label=m,value=v,color=colors[m]) for m,v in models.most_common()],headers=[tr(k,e) for k,e in [('세션','Session'),('모델','Model'),('루프','Loop'),('입력','Input'),('출력','Output'),('캐시 읽기','Cache read'),('캐시 쓰기','Cache write'),('요청','Requests'),('처리 토큰','Processed')]],rows=loop_rows+[list(['effort',k,'',0,0,0,0,v,0]) for k,v in efforts.items()])
    section('비용과 장부','Cost and ledger',headers=[tr('세션','Session'),'USD',tr('보조·압축','Auxiliary / compaction'),tr('장부 상태','Ledger state')],rows=ledger_rows)
    if runs:
        section('Codex 외부 사용량','Codex external usage',headers=[tr('실행','Run'),tr('모델','Model'),tr('처리 토큰','Processed tokens'),tr('시간','Time'),tr('짝 세션','Matched session')],rows=[['X'+str(i),x.get('model'),x['tokens']['processed'],clock(x['startedAt'])+' ~ '+clock(x['endedAt']),x.get('matchedSession')] for i,x in enumerate(runs,1)])
    sid_index = {s['sessionId']:s['index'] for s in sessions}
    section('세션 목록과 관계','Sessions and relationships',headers=[tr(k,e) for k,e in [('순번','Index'),('시작과 끝','Start and end'),('분','Minutes'),('출처','Source'),('표면','Surface'),('주 모델','Main model'),('처리 토큰','Processed'),('서브','Agents'),('부모','Parent'),('외부 짝','External matches')]],rows=[[s['index'],clock(s['startedAt'])+' ~ '+clock(s['endedAt']),round((s['endedAt']-s['startedAt'])/60000,2),s.get('source') or 'mod',records[s['index']][0].get('run',{}).get('surface'),max(((m,processed(u)) for m,u in s['usage'].get('main',{}).items()),key=lambda x:x[1],default=('',0))[0],s['processed'],sum(len(r.get('agents',{})) for r in records[s['index']]),next((sid_index.get(r.get('parentSessionId'),'') for r in records[s['index']] if r.get('parentSessionId')),''),sum(x.get('matchedSession')==s['index'] for x in runs)] for s in sessions])
    for i,x in enumerate(runs,1):
        lanes.append(dict(label='X'+str(i),start=x['startedAt'],end=x['endedAt'],color='--ext'))
    section('위임 지도(시간축 겹침)','Delegation map (time overlap)',kind='timeline',chart=lanes)
    representative_session = next(s for s in sessions if s['index'] == representative)
    r0,r1 = representative_session['startedAt'],representative_session['endedAt']
    rtick = 600000 if r1-r0 < 7200000 else 3600000 if r1-r0 < 86400000 else 86400000
    section('대표 세션 타임라인','Representative session timeline',text=representative,kind='timeline',chart=timeline,axis=dict(t0=r0,t1=r1,tickMs=rtick,bucketMs=rtick),ticks=ticks(r0,r1,rtick))
    section('마찰 카운터','Friction counters',headers=[tr('세션','Session'),'aborted','toolErrors','rejected','compactions',tr('insights 보조','insights auxiliary'),'outcome'],rows=friction)
    section('정본 지문 변화','Canonical fingerprint changes',text=str(len(fingerprint))+tr('회 변경',' changes') if previous else tr('측정 안 됨(백필은 지문 없음)','Not measured (no fingerprints in backfill)'),rows=fingerprint)
    section('메타데이터 가설','Metadata hypotheses',text='' if hypotheses else tr('해당 없음','None applicable'),cards=hypotheses)
    if profile:
        declared = dict(profile.get('lanes',{}))
        rows = [[profile.get('mainLane','main'),tr('선언','Declared'),len(sessions),sum(processed(u) for s in sessions for u in s['usage'].get('main',{}).values())]]
        for kind in sorted(set(declared)|set(declarations)|set(profile.get('externalAgentTypes',[]))):
            count,value = declarations[kind]
            rows.append([declared.get(kind,kind),tr('선언','Declared') if kind in declared or kind in profile.get('externalAgentTypes',[]) else tr('미선언','Undeclared'),count,value])
        section('선언 대 실제','Declared versus actual',headers=[tr('레인','Lane'),tr('선언 여부','Declaration'),tr('실제 spawn 수','Actual spawns'),tr('처리 토큰','Processed tokens')],rows=rows)
    section('도구 상위 10과 기록 범위','Top 10 tools and coverage',rows=[[k,v] for k,v in tools.most_common(10)],text=tr('요청 기준 tool_use. 처리 토큰 = 입력 + 캐시 쓰기 + 출력, 캐시 읽기 제외. 외부 사용량은 별도이며 합계에 더하지 않는다. 작업 시간은 겹침을 포함한다. 보조·압축은 cost-state 장부와 요청 합의 차이인 추정값이다. mod 우선, 백필 보완. 본문과 도구 입력은 수집하지 않는다.','Requested tool_use counts. Processed tokens = input + cache write + output, excluding cache reads. External usage is separate. Work duration includes overlap. Auxiliary usage estimates the ledger minus request difference. Prefer mod over backfill. Message bodies and tool inputs are excluded.'))
    prepare(data, sessions, records, runs, profile, totals)
    return data, totals


def aar(args, root, configs):
    profile_path = args.profile or (Path(root)/'profile.json' if (Path(root)/'profile.json').exists() else None)
    data, totals = build_report_data(root,[s for v in args.project for s in v.split(',')],configs,args.title,args.t0,args.t1,optional(args.cards),optional(profile_path),args.codex_dir,args.tz,args.no_ledger)
    render(data,args.out)
    return dict(output=str(args.out),**totals),0
