"""보고서와 장부 검증. 합성 픽스처를 임시 디렉터리에서만 사용한다."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unittest

from backfill import backfill
from cli import main
from export import export, ALLOWED_PATHS
from ledger import register
from paths import millis, read_json

FIXTURES = Path(__file__).parent / 'fixtures'


class ReportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.fixtures = self.base/'fixtures'
        shutil.copytree(FIXTURES,self.fixtures)
        self.root = self.base/'root'
        self.expected = read_json(self.fixtures/'expected.json')
        self.configs = [self.fixtures/'cfg-a',self.fixtures/'cfg-b']
        now = millis(self.expected['now'])/1000
        for config in self.configs:
            for path in (config/'projects').glob('*/*.jsonl'):
                os.utime(path,(now-(60 if path.stem.endswith('4') else 172800),)*2)
        result, code = backfill(self.configs,self.root,now=self.expected['now'])
        self.assertEqual(code,0)
        self.slug = next((self.root/'_backfill').iterdir()).name
        self.out = self.base/'aar.html'
        # 프로필 없는 보고서의 언어는 로케일을 따르므로 검사에서는 한국어로 고정한다.
        self.locale(ko=True)

    def locale(self, ko):
        saved = {k: os.environ.get(k) for k in ('LC_ALL', 'LANG')}
        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)
        os.environ.pop('LC_ALL', None)
        os.environ['LANG'] = 'ko_KR.UTF-8' if ko else 'en_US.UTF-8'

    def invoke(self,*args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(['--root',str(self.root)]+list(args))
        return code,json.loads(output.getvalue().splitlines()[-1][7:])

    def aar(self,profile=True,extra=()):
        args = ['aar','--project',self.slug,'--cards',str(self.fixtures/'cards.json'),'--codex-dir',str(self.fixtures/'codex'),'--tz','+09:00','--out',str(self.out)]
        for c in self.configs:
            args += ['--config',str(c)]
        if profile:
            args += ['--profile',str(self.fixtures/'profile.json')]
        code,result = self.invoke(*(args+list(extra)))
        self.assertEqual(code,0,result)
        html = self.out.read_text()
        data = json.loads(re.search(r'<script type="application/json" id="aar-data">(.*?)</script>',html,re.S).group(1))
        return html,data,result

    def test_visual_stacks_preserve_totals_and_external_separation(self):
        _, data, result = self.aar()
        get = lambda kind: next(s for s in data['sections'] if s.get('kind') == kind)
        self.assertEqual(data['layout'], 'aar')
        self.assertEqual(len(get('hero')['cards']), 4)
        for kind in ('models', 'loops'):
            self.assertEqual(sum(r['value'] for r in get(kind)['chart']), result['processed'])
        self.assertEqual(sum(r['value'] for r in get('external')['chart']), 670)
        self.assertEqual(get('hero')['cards'][0]['body'], '966')
        model_totals = {}
        for row in get('models')['chart']:
            model_totals[row['label']] = model_totals.get(row['label'], 0) + row['value']
        self.assertEqual(model_totals, self.expected['project']['byModelProcessed'])
        timeline = get('activity')
        self.assertEqual(timeline['axis']['bucketMs'], 300000)
        self.assertEqual(sum(r['value'] for r in timeline['chart'] if r['role'] == 'bucket'), 673)
        for row in timeline['chart']:
            if row['role'] == 'bucket':
                self.assertEqual(row['start'] % 300000, 0)
                self.assertEqual(row['end'] - row['start'], 300000)
        lanes = get('delegation')['chart']
        self.assertTrue(any(r['parent'] == 'S2' and r['role'] == 'external' for r in lanes))
        self.assertTrue(any(r['parent'] == 'S2' and r['role'] == 'agent' for r in lanes))
        export(data, strict=True)

    def test_sdk_one_shot_is_folded_without_removing_usage(self):
        path = next(p for p in (self.root/'_backfill').glob('*/*/*.json') if p.parent.name.endswith('1'))
        record = read_json(path)
        record['run']['surface'] = 'sdk-py'
        record['usage'] = {'main': {'claude-test-big': {'in': 2, 'out': 3, 'cacheWrite': 5, 'cacheRead': 20, 'steps': 1, 'nullUsageSteps': 0}}}
        record['agents'] = {}
        path.write_text(json.dumps(record))
        _, data, result = self.aar()
        get = lambda kind: next(s for s in data['sections'] if s.get('kind') == kind)
        self.assertEqual(get('helpers')['title'], '자동 보조 1건')
        self.assertEqual([r[0] for r in get('helpers')['rows']], ['S1'])
        self.assertEqual([r[0] for r in get('sessions')['rows']], ['S2', 'S3'])
        self.assertFalse(any(r['label'] == 'S1' for r in get('delegation')['chart']))
        self.assertEqual(get('hero')['cards'][3]['body'], '2')
        self.assertEqual(result['processed'], 831)
        self.assertEqual(sum(r['value'] for r in get('models')['chart']), 831)
        # SDK라도 여러 요청과 위임이 있는 S2는 자동 보조로 접지 않는다.
        self.assertTrue(any(r['label'] == 'S2' for r in get('delegation')['chart']))

    def test_timeline_marks_known_events_without_inventing_compaction_times(self):
        path = next(p for p in (self.root/'_backfill').glob('*/*/*.json') if p.parent.name.endswith('3'))
        record = read_json(path)
        at = record['run']['startedAt'] + 60000
        record['tags'] = [dict(label='검증 단계', at=at)]
        record['turns'] = [dict(startedAt=at, durationMs=1000, aborted=True)]
        record['friction'].update(aborted=2, compactions=3)
        path.write_text(json.dumps(record))
        _, data, _ = self.aar()
        timeline = next(s for s in data['sections'] if s.get('kind') == 'activity')
        markers = [r for r in timeline['chart'] if r['role'] not in ('bucket', 'span')]
        self.assertEqual([(r['role'], r['start']) for r in markers], [('tag', at), ('aborted', at + 1000)])
        self.assertIn(['압축', 3, '3건 시각 미수집'], timeline['rows'])
        self.assertIn(['중단', 2, '1건 시각 미수집'], timeline['rows'])

    def test_language_follows_the_profile_then_the_locale(self):
        _, data, _ = self.aar(profile=True)
        self.assertEqual(data['language'], 'ko')
        self.locale(ko=False)
        _, data, _ = self.aar(profile=True)
        self.assertEqual(data['language'], 'ko', '프로필의 언어가 로케일보다 앞선다')
        _, data, _ = self.aar(profile=False)
        self.assertEqual(data['language'], 'en')
        self.assertEqual(data['sections'][1]['cards'][0]['title'], 'Processed tokens')
        self.locale(ko=True)
        _, data, _ = self.aar(profile=False)
        self.assertEqual(data['language'], 'ko')
        self.assertEqual(data['sections'][1]['cards'][0]['title'], '처리 토큰')

    def test_timeline_main_spans_follow_the_five_minute_gap_rule(self):
        _, data, _ = self.aar()
        timeline = next(s for s in data['sections'] if s.get('kind') == 'activity')
        spans = [r for r in timeline['chart'] if r['role'] == 'span']
        buckets = [r for r in timeline['chart'] if r['role'] == 'bucket']
        self.assertTrue(spans)
        self.assertTrue(timeline['text'].startswith(spans[0]['group'] + ' '))
        self.assertGreater(sum(r['value'] for r in spans), 0)
        self.assertLessEqual(sum(r['value'] for r in spans), sum(r['value'] for r in buckets))
        for r in spans:
            self.assertLessEqual(r['start'], r['end'])
            self.assertGreaterEqual(r['start'], timeline['axis']['t0'])
            self.assertLessEqual(r['end'], timeline['axis']['t1'])
        for a, b in zip(spans, spans[1:]):
            self.assertLessEqual(a['end'], b['start'])
            if a['label'] == b['label']:
                self.assertGreater(b['start'] - a['end'], timeline['axis']['bucketMs'])
        export(data, strict=True)

    def test_work_time_is_union_and_declared_main_counts_work_sessions(self):
        # Make S3 overlap S2 so the union differs from the plain sum.
        paths = sorted((self.root/'_backfill').glob('*/*/*.json'), key=lambda p: p.parent.name)
        s2, s3 = read_json(paths[1]), read_json(paths[2])
        s3['run']['startedAt'] = s2['run']['startedAt'] + 60000
        s3['run']['endedAt'] = max(s3['run']['endedAt'], s2['run']['endedAt'] + 60000)
        paths[2].write_text(json.dumps(s3))
        s1 = read_json(paths[0])
        s1['run']['surface'] = 'sdk-py'
        s1['agents'] = {}
        s1['usage'] = {'main': {'claude-test-big': {'in': 2, 'out': 3, 'cacheWrite': 5, 'cacheRead': 20, 'steps': 1, 'nullUsageSteps': 0}}}
        s1['events'] = []
        paths[0].write_text(json.dumps(s1))
        for path, record in ((paths[1], s2), (paths[2], s3)):
            record['events'] = [dict(kind='compaction', at=record['run']['startedAt'] + 30000)]
            path.write_text(json.dumps(record))
        _, data, _ = self.aar()
        get = lambda kind: next(s for s in data['sections'] if s.get('kind') == kind)
        spans = sorted((r['run']['startedAt'], r['run']['endedAt']) for r in (read_json(p) for p in paths))
        union, end = 0, None
        for a, b in spans:
            if end is None or a > end:
                union, end = union + b - a, b
            elif b > end:
                union, end = union + b - end, b
        summed = sum(b - a for a, b in spans)
        self.assertLess(union, summed)
        hero = get('hero')['cards'][2]
        self.assertEqual(hero['body'], f'{union/60000:,.1f}')
        self.assertIn(f'겹침 포함 합 {summed/60000:,.1f}분', ' '.join(hero['evidence']))
        main_row = get('declarations')['rows'][0]
        self.assertEqual(main_row[2], 2)
        self.assertIn('자동 보조 1건 별도', main_row[1])
        work_main = sum(sum(u[k] for k in ('in', 'out', 'cacheWrite')) for r in (s2, s3) for u in r['usage'].get('main', {}).values())
        self.assertEqual(main_row[3], work_main)
        # The representative session's compaction time comes from backfill events.
        self.assertTrue(any(r['role'] == 'compactions' for r in get('activity')['chart']))

    def test_incomplete_review_keeps_four_card_positions(self):
        cards = read_json(self.fixtures/'cards.json')
        cards['cards'] = [c for c in cards['cards'] if c['k'] == 'gap']
        (self.fixtures/'cards.json').write_text(json.dumps(cards))
        _, data, _ = self.aar()
        review = next(s for s in data['sections'] if s.get('kind') == 'review')['cards']
        self.assertEqual([c['title'] for c in review], ['계획', '실제', '차이', '개선'])
        self.assertEqual(review[0]['body'], '작성되지 않음')
        self.assertEqual(review[2]['body'], '픽스처 차이 문단.')
        with self.assertRaises(ValueError):
            export({'sections': [{'chart': [{'parent': '/Users/example/private'}]}]}, strict=True)  # precheck: allow (synthetic ID or path)
        with self.assertRaises(ValueError):
            export({'sections': [{'chart': [{'raw': 'private'}]}]}, strict=True)

    def test_report_totals_privacy_and_cards(self):
        html,data,result = self.aar()
        for key in ('processed','cacheRead','requests','usdTotal'):
            self.assertEqual(result[key],self.expected['project'][key])
        self.assertEqual(result['usdTotal'],.45)
        self.assertIn('$0.45',html)
        self.assertIn('966',html)
        external = next(s for s in data['sections'] if s['title']=='Codex 외부 사용량')
        self.assertEqual(external['rows'][0][2],670)
        self.assertEqual(external['rows'][0][-1],'S2')
        for text in ('계획','실제','차이','개선','추정','메타데이터 가설','선언 대 실제'):
            self.assertIn(text,html)
        improvements = next(s for s in data['sections'] if s['title']=='개선 항목')['cards']
        self.assertEqual(len(improvements),2)
        for item in improvements:
            self.assertIn('이 프롬프트는 AAR 맥락 없이 실행된다',item['prompt'])
        self.assertIn('navigator.clipboard.writeText',html)
        self.assertIn('적용 프롬프트 복사',html)
        export(data,strict=True)
        self.assertTrue(ALLOWED_PATHS)
        for text in ('FORBIDDEN-MARKER-','/tmp/proj','aaaaaaaa-0000','cccccccc-0000','-tmp-proj-alpha','req_f','msg_f','toolu_','sessionId','agentId','runId','response_id','slug'):
            self.assertNotIn(text,html)
        self.assertIsNone(re.search(r'[\U0001f000-\U0001ffff\u2190-\u21ff\u25b6]',html))
        self.assertIsNone(re.search(r'(?:src|href)=["\']https?://',html))
        self.assertEqual(html.count('type="application/json"'),1)
        self.assertIn('\\u003cb>',html)
        ledger = next(s for s in data['sections'] if s['title']=='비용과 장부')
        self.assertEqual(ledger['rows'][0][2]['value'],140)
        self.assertEqual(ledger['rows'][1][-1],'장부 지연')
        self.assertEqual(set(data['axis']),{'t0','t1','tickMs','bucketMs'})

    def test_profile_absent_and_costless(self):
        for path in (self.root/'_backfill').glob('*/*/*.json'):
            record = read_json(path)
            record.pop('cost',None)
            record.pop('ledger',None)
            path.write_text(json.dumps(record))
        html,data,_ = self.aar(False,('--no-ledger',))
        self.assertNotIn('선언 대 실제',html)
        self.assertEqual(data['sections'][1]['title'],'처리 토큰')
        self.assertEqual(data['sections'][1]['text'],'966')
        self.assertFalse((self.root/'ledger.json').exists())

    def test_ledger_idempotency_recurrence_and_set(self):
        self.aar()
        first = read_json(self.root/'ledger.json')['items']
        self.aar()
        second = read_json(self.root/'ledger.json')['items']
        self.assertEqual([i['id'] for i in first],[i['id'] for i in second])
        self.assertEqual(len(second),2)
        self.assertRegex(second[0]['id'],r'^i-\d{8}-[a-f0-9]{6}$')
        source = read_json(self.fixtures/'cards.json')['improvements'][0]
        source['title'] += ' 개선'
        rec = register(self.root,[source],'합성')[0]
        self.assertIn(first[0]['id'],rec['recurrenceOf'])
        ident = first[0]['id']
        self.assertEqual(self.invoke('ledger','set',ident,'applied')[0],0)
        self.aar()
        code,result = self.invoke('ledger','list','--status','applied')
        self.assertEqual(code,0)
        self.assertEqual(result['items'][0]['id'],ident)
        self.assertEqual(self.invoke('ledger','set','missing','verified')[0],2)

    def test_summary_two_projects(self):
        sid = next(s for s in self.expected['sessions'] if s.endswith('3'))
        code,result = self.invoke('summary','--session',sid,'--codex-dir',str(self.fixtures/'codex'),'--profile',str(self.fixtures/'profile.json'),'--out',str(self.out))
        self.assertEqual(code,0,result)
        self.assertEqual(result['processed'],673)
        self.assertEqual(result['projects'],2)
        html = self.out.read_text()
        for text in ('알파','베타','600','73'):
            self.assertIn(text,html)
        self.assertNotIn(self.slug,html)
        self.assertNotIn(sid,html)

    def test_summary_auxiliary_cell(self):
        for suffix, marker in (('3', '측정 안 됨'), ('1', 'cost-state 장부 - transcript 요청 합')):
            sid = next(s for s in self.expected['sessions'] if s.endswith(suffix))
            code,result = self.invoke('summary','--session',sid,'--codex-dir',str(self.fixtures/'codex'),'--profile',str(self.fixtures/'profile.json'),'--out',str(self.out))
            self.assertEqual(code,0,result)
            html = self.out.read_text()
            self.assertIn('보조·압축',html)
            self.assertIn(marker,html)

    def test_export_id_pattern_keeps_plain_words(self):
        self.assertEqual(export(dict(title='msg_status 필드 설명 req_count')), dict(title='msg_status 필드 설명 req_count'))
        self.assertEqual(export(dict(title='id msg_01AbCdEfGhIjKlMn')), dict(title='[redacted]'))  # precheck: allow (synthetic ID or path)
        self.assertEqual(export(dict(title='resp_' + 'a1' * 12)), dict(title='[redacted]'))
        for value in ('msg_bdrk_01AbCdEfGhIj', 'msg_vrtx_01AbCdEfGhIj', 'req_011CAbCdEfGhIjKl', 'toolu_01AbCdEfGhIjKl', 'msg_abcdefgh12345678'):  # precheck: allow (synthetic ID or path)
            self.assertEqual(export(dict(title=value)), dict(title='[redacted]'), value)

    def test_backfill_old_copy_does_not_hide_newer_copy(self):
        src = self.fixtures/'cfg-a'/'projects'/self.slug
        sid = sorted(p.name for p in src.glob('*.jsonl'))[0]
        for name, age in (('old', 90), ('new', 0)):
            folder = self.base/name/'projects'/self.slug
            folder.mkdir(parents=True)
            shutil.copy(src/sid, folder/sid)
            stamp = millis(self.expected['now'])/1000 - age*86400
            os.utime(folder/sid, (stamp, stamp))
        result, code = backfill([self.base/"old", self.base/"new"], self.base/"root2", days=30, projects=[self.slug], now=self.expected['now'])
        self.assertEqual((result['found'], result['written']), (1, 1))

    def test_codex_pick_prefers_delegation_then_containment(self):
        from codex import pick
        long = dict(index='S1',startedAt=0,endedAt=10_000_000)
        short = dict(index='S2',startedAt=1_000_000,endedAt=2_000_000)
        late = dict(index='S3',startedAt=2_100_000,endedAt=2_200_000)
        # containment beats the old nearest-start grace (S3 started closer but does not hold the start)
        self.assertEqual(pick([long,short,late],1_900_000)['index'],'S2')
        # a declared external-agent window wins over containment
        self.assertEqual(pick([dict(long,externalWindows=[(1_800_000,1_950_000)]),short],1_900_000)['index'],'S1')
        # grace only when nothing holds the start
        self.assertEqual(pick([short],2_100_000)['index'],'S2')
        self.assertIsNone(pick([short],2_400_000))

    def test_export_rejects_unknown_paths_and_values(self):
        with self.assertRaises(ValueError):
            export({'unknown':'value'},strict=True)
        with self.assertRaises(ValueError):
            export({'title':'/Users/example/private'},strict=True)  # precheck: allow (synthetic ID or path)
        self.assertEqual(export({'title':'a'*64})['title'],'[redacted]')

    def test_english_and_optional_corruption(self):
        profile = read_json(self.fixtures/'profile.json')
        profile['language'] = 'en'
        (self.fixtures/'profile.json').write_text(json.dumps(profile))
        html,data,_ = self.aar()
        self.assertEqual(data['language'],'en')
        self.assertIn('Declared versus actual',html)
        self.assertIn('Copy apply prompt',html)
        self.assertIn('This prompt runs without AAR context',html)
        (self.fixtures/'profile.json').write_text('{')
        (self.fixtures/'cards.json').write_text('{')
        self.aar()

    def test_default_profile_filters_and_mod_preference(self):
        shutil.copyfile(self.fixtures/'profile.json',self.root/'profile.json')
        records = sorted((self.root/'_backfill').glob('*/*/*.json'))
        record = read_json(records[0])
        mod = self.root/'runs'/records[0].parent.parent.name/records[0].parent.name/'mod.json'
        mod.parent.mkdir(parents=True)
        record['source'] = 'mod'
        record['usage']['main'][next(iter(record['usage']['main']))]['in'] += 1
        mod.write_text(json.dumps(record))
        html,data,result = self.aar(False,('--from','2026-10-10T00:00:00Z','--to','2026-10-10T23:59:59Z'))
        self.assertEqual(result['processed'],146)
        self.assertIn('선언 대 실제',html)
        self.assertIn('mod 1',data['sections'][0]['text'])
        cost = next(s for s in data['sections'] if s['title']=='비용과 장부')
        self.assertEqual(cost['rows'][0][2],'측정 안 됨')

    def test_hypothesis_thresholds_and_sanitized_ledger(self):
        profile = read_json(self.fixtures/'profile.json')
        profile['hypotheses'] = {'long-no-subagent':{'minutes':1},'single-top-model':{'requests':1,'share':.1},'tool-error-rate':{'calls':1,'rate':0}}
        (self.fixtures/'profile.json').write_text(json.dumps(profile))
        cards = read_json(self.fixtures/'cards.json')
        cards['improvements'][0]['what'] = 'FORBIDDEN-MARKER-private'
        (self.fixtures/'cards.json').write_text(json.dumps(cards))
        html,data,_ = self.aar()
        hypotheses = next(s for s in data['sections'] if s['title']=='메타데이터 가설')['cards']
        self.assertGreaterEqual(len(hypotheses),3)
        self.assertTrue(all(c['badge']=='가설' for c in hypotheses))
        self.assertNotIn('FORBIDDEN-MARKER-',html)
        self.assertNotIn('FORBIDDEN-MARKER-',(self.root/'ledger.json').read_text())

    def test_summary_unclassified_and_single_threshold(self):
        sid = next(s for s in self.expected['sessions'] if s.endswith('3'))
        for threshold,count,title in ((.5,1,'단일 프로젝트 세션'),(.01,2,'알파')):
            code,result = self.invoke('summary','--session',sid,'--threshold-share',str(threshold),'--threshold-min','999','--profile',str(self.fixtures/'profile.json'),'--codex-dir',str(self.fixtures/'codex'),'--out',str(self.out))
            self.assertEqual(code,0,result)
            self.assertEqual(result['projects'],count)
            self.assertIn(title,self.out.read_text())

        record_path = next(p for p in (self.root/'_backfill').glob('*/*/*.json') if p.parent.name == sid)
        record = read_json(record_path)
        record['attribution'][self.slug]['processed'] -= 10
        record['attribution']['synthetic-third'] = dict(processed=10,firstAt=0,lastAt=0)
        record_path.write_text(json.dumps(record))
        code,result = self.invoke('summary','--session',sid,'--threshold-min','999','--profile',str(self.fixtures/'profile.json'),'--codex-dir',str(self.fixtures/'codex'),'--out',str(self.out))
        self.assertEqual(code,0,result)
        self.assertEqual(result['processed'],673)
        self.assertIn('미분류',self.out.read_text())
