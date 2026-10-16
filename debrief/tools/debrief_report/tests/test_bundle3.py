"""압축은 임시 폴더의 합성 레코드로만 검증한다."""
import contextlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from aar import records_for
from cli import main
from compact import compact
from model import load_project
from paths import millis, read_json

NOW = '2026-10-15T00:00:00Z'
OLD = millis('2026-07-12T00:00:00Z')


class Bundle3(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def put(self, sid, rid, source='mod', end=OLD, checkpoint=None):
        record = dict(runId=rid, sessionId=sid, source=source, project=dict(slug='project'),
                      run=dict(startedAt=OLD-1000),
                      usage=dict(main=dict(m=dict(in_=0))), effort=dict(m=dict(high=2)),
                      cost=dict(usdAtStart=2, usdAtEnd=3, provenance='engine-ledger'),
                      agents=dict(a=dict(subagentType='worker', model='m', firstSeenAt=OLD-1000, durationMs=500, description='FORBIDDEN-MARKER-agent')),
                      friction=dict(aborted=1, toolErrors=None, rejected=None, compactions=None),
                      tags=[dict(label='phase', at=OLD, turnIndex=0)], instructions=[],
                      requestedToolCalls=dict(main=dict(Read=2)), steps=[dict(text='FORBIDDEN-MARKER-step')], turns=[])
        record['usage']['main']['m'] = dict(zip(('in','out','cacheRead','cacheWrite','steps','nullUsageSteps'), (2,3,7,5,4,1)))
        if end is not None:
            record['run']['endedAt'] = end
        if checkpoint is not None:
            record['run']['lastCheckpointAt'] = checkpoint
        if source == 'backfill':
            record['ledger'] = dict(groups=1, models=dict(m=dict(zip(('in','out','cacheRead','cacheWrite','usd'), (4,6,14,10,1)))))
            record['attribution'] = dict(project=dict(steps=3, processed=10, firstAt=OLD-1000, lastAt=OLD))
        path = self.root / ('runs' if source == 'mod' else '_backfill') / 'project' / sid / (rid + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding='utf-8')
        return path

    def seed(self):
        return [self.put('s1','r1'), self.put('s1','r2'), self.put('s2','backfill','backfill')]

    def snapshot(self):
        return {str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def totals(self):
        return {k:sum(s[k] for s in load_project(self.root)) for k in ('processed','requests','cacheRead','usdTotal')}

    def test_archive_rollup_and_bytes(self):
        paths = self.seed()
        before = {p.relative_to(self.root).as_posix():p.read_bytes() for p in paths}
        result, code = compact(self.root, now=NOW)
        self.assertEqual((result['targets'],code), (3,0))
        self.assertTrue(all(not p.exists() and not p.parent.exists() for p in paths))
        rollup = read_json(self.root/'runs/project/rollup-2026-07.json')
        self.assertEqual(rollup['sessions']['s1']['runIds'], ['r1','r2'])
        self.assertEqual(rollup['sessions']['s1']['agents']['a']['durationMs'], 1000)
        self.assertIsNone(rollup['sessions']['s1']['friction']['toolErrors'])
        self.assertNotIn('FORBIDDEN-MARKER', json.dumps(rollup))
        self.assertNotIn('steps', rollup['sessions']['s1'])
        with tarfile.open(self.root/'archive/2026-07.tar.gz') as archive:
            self.assertEqual(set(archive.getnames()), set(before))
            for name, data in before.items():
                self.assertEqual(archive.extractfile(name).read(), data)

    def test_idempotence_and_existing_archive(self):
        paths = self.seed()
        raw = paths[0].read_bytes()
        compact(self.root, now=NOW)
        before = self.snapshot()
        compact(self.root, now=NOW)
        self.assertEqual(before, self.snapshot())
        # 원본 삭제 전에 중단된 경우를 재현한다.
        paths[0].parent.mkdir(parents=True)
        paths[0].write_bytes(raw)
        compact(self.root, now=NOW)
        self.assertEqual(before['runs/project/rollup-2026-07.json'], self.snapshot()['runs/project/rollup-2026-07.json'])
        self.put('s3','r3')
        compact(self.root, now=NOW)
        with tarfile.open(self.root/'archive/2026-07.tar.gz') as archive:
            self.assertEqual(len(archive.getnames()), 4)
            self.assertEqual(len(set(archive.getnames())), 4)
            self.assertEqual(archive.extractfile('runs/project/s1/r1.json').read(), raw)

    def test_recent_and_open(self):
        recent = millis('2026-10-14T00:00:00Z')
        paths = [self.put('recent','r',end=recent), self.put('open','r',end=None,checkpoint=recent)]
        stale = self.put('stale','r',end=None,checkpoint=OLD)
        fallback = self.put('fallback','r',end=None)
        compact(self.root, now=NOW)
        self.assertTrue(all(p.exists() for p in paths))
        self.assertFalse(stale.exists())
        self.assertFalse(fallback.exists())

    def test_dry_run_writes_nothing(self):
        self.seed()
        before = self.snapshot()
        dirs = sorted(str(p) for p in self.root.rglob('*'))
        result, code = compact(self.root, now=NOW, dry_run=True)
        self.assertEqual((result['targets'],result['months'][0]['sessions'],code), (3,2,0))
        self.assertEqual(before, self.snapshot())
        self.assertEqual(dirs, sorted(str(p) for p in self.root.rglob('*')))

    def test_delete_requires_yes(self):
        self.seed()
        compact(self.root, now=NOW)
        path = self.root/'archive/2026-07.tar.gz'
        same = self.root/'archive/2026-08.tar.gz'
        same.write_bytes(path.read_bytes())
        args = ['compact','--root',str(self.root),'--delete-archives-before','2026-08']
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(main(args), 2)
        self.assertIn('RESULT ', stdout.getvalue())
        self.assertIn(str(path), stdout.getvalue())
        self.assertTrue(path.exists())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(args + ['--yes']), 0)
        self.assertFalse(path.exists())
        self.assertTrue(same.exists())

    def test_totals_and_aar_records(self):
        self.seed()
        before = self.totals()
        compact(self.root, now=NOW)
        self.assertEqual(before, self.totals())
        for session in load_project(self.root):
            self.assertEqual(session['source'], 'rollup')
            records = records_for(self.root, session)
            self.assertEqual(len(records), 1)
            self.assertNotIn('steps', records[0])

    def test_partial_months_and_source_precedence(self):
        self.put('s1','r1')
        self.put('s1','r2',end=millis('2026-08-12T00:00:00Z'))
        self.put('s1','r3',end=millis('2026-10-14T00:00:00Z'))
        self.put('s1','backfill','backfill')
        before = self.totals()
        compact(self.root, now=NOW)
        self.assertEqual(before, self.totals())
        compact(self.root, now='2026-12-15T00:00:00Z')
        self.assertEqual(before, self.totals())
        self.assertEqual(len(records_for(self.root, load_project(self.root)[0])), 1)

    def test_verification_failure_keeps_raw(self):
        self.seed()
        before = self.snapshot()
        with patch('compact.tarfile.TarFile.extractfile', return_value=io.BytesIO(b'wrong')):
            with self.assertRaises(ValueError):
                compact(self.root, now=NOW)
        self.assertEqual(before, self.snapshot())

    def test_cli_compact_and_invalid_options(self):
        self.seed()
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(main(['compact','--root',str(self.root),'--now',NOW,'--dry-run']), 0)
        self.assertEqual(json.loads(stdout.getvalue().split('RESULT ')[1])['targets'], 3)
        for flags in (['--days','0'], ['--days','nan'], ['--delete-archives-before','2026-13']):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['compact','--root',str(self.root)] + flags), 2)

    def test_cutoff_and_utc_month(self):
        now = millis(NOW)
        boundary = self.put('boundary','r',end=now-30*86400000)
        opened = self.put('open-boundary','r',end=None,checkpoint=now-60*86400000)
        self.put('utc','r',end=millis('2026-08-01T00:30:00+02:00'))
        compact(self.root, now=NOW)
        self.assertTrue(boundary.exists())
        self.assertTrue(opened.exists())
        self.assertIn('utc', read_json(self.root/'runs/project/rollup-2026-07.json')['sessions'])

    def test_rollup_preserves_ledger_attribution_and_cost(self):
        self.put('s1','backfill','backfill')
        compact(self.root, now=NOW)
        session = load_project(self.root)[0]
        record = records_for(self.root, session)[0]
        self.assertEqual(record['ledger']['groups'], 1)
        self.assertEqual(record['attribution']['project']['processed'], 10)
        self.assertEqual((session['usdTotal'],session['estimated']), (1,False))

    def test_rollup_write_failure_can_be_retried(self):
        paths = self.seed()
        with patch('compact.atomic_json', side_effect=OSError('write failed')):
            with self.assertRaises(OSError):
                compact(self.root, now=NOW)
        self.assertTrue(all(p.exists() for p in paths))
        before = self.totals()
        compact(self.root, now=NOW)
        self.assertEqual(before, self.totals())
        with tarfile.open(self.root/'archive/2026-07.tar.gz') as archive:
            self.assertEqual(len(archive.getnames()), 3)
