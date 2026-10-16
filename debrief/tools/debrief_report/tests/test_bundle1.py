"""합성 입력만 임시 디렉터리에 복사해 검사한다."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backfill import backfill
from cli import main
from codex import codex_usage
from insights import insights_for, META_KEYS, FACET_KEYS
from model import load_project, overlap
from paths import atomic_json, millis, read_json
from transcript import parse_session

FIXTURES = Path(__file__).parent / 'fixtures'
ENTRY = Path(__file__).resolve().parents[1]


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.data = self.base / 'fixtures'
        shutil.copytree(FIXTURES, self.data)
        self.expected = read_json(self.data / 'expected.json')
        self.now = millis(self.expected['now'])
        self.configs = [self.data / 'cfg-a', self.data / 'cfg-b']
        self.root = self.base / 'output'
        for config in self.configs:
            for p in (config / 'projects').glob('*/*.jsonl'):
                age = 60 if p.stem.endswith('4') else 172800
                os.utime(p, ((self.now / 1000)-age,) * 2)
        self.result, self.code = backfill(self.configs, self.root, now=self.expected['now'])
        self.slug = next((self.root / '_backfill').iterdir()).name

    def records(self):
        return {p.parent.name: read_json(p) for p in (self.root / '_backfill').glob('*/*/*.json')}

    def invoke(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(args)
        text = output.getvalue()
        self.assertTrue(text.splitlines()[-1].startswith('RESULT '))
        return code, json.loads(text.splitlines()[-1][7:]), text

    def test_fixture_counts_and_metadata(self):
        self.assertEqual(self.code, 0)
        for key in ('found','closed','written'):
            self.assertEqual(self.result[key], self.expected['backfill'][key])
        self.assertEqual([s['reason'] for s in self.result['skipped']], ['open'])
        self.assertEqual(self.result['badLines'], 1)
        records = self.records()
        self.assertEqual(set(records), set(self.expected['sessions']))
        for sid, expected in self.expected['sessions'].items():
            with self.subTest(session=sid):
                record = records[sid]
                if 'badLines' in expected:
                    source = self.data / expected['config'] / 'projects' / self.slug / (sid + '.jsonl')
                    self.assertEqual(parse_session(source)[2], expected['badLines'])
                self.assertEqual(record['usage'], expected['usage'])
                for loop, models in expected['usage'].items():
                    for model, counts in models.items():
                        actual = record['usage'][loop][model]
                        self.assertEqual(actual['steps']-actual['nullUsageSteps'], counts['steps']-counts['nullUsageSteps'])
                for key in ('effort','friction','cost','ledger','requestedToolCalls'):
                    if key in expected:
                        self.assertEqual(record[key], expected[key])
                for key in ('endReason','surface','isInteractive','coverage'):
                    self.assertEqual(record['run'][key], expected[key])
                for key in ('startedAt','endedAt'):
                    self.assertEqual(record['run'][key], millis(expected[key]))
                for slug, values in expected.get('attribution', {}).items():
                    for key, value in values.items():
                        self.assertEqual(record['attribution'][slug][key], value)
                for model, processed in expected['processed'].items():
                    actual = sum(u['in']+u['out']+u['cacheWrite'] for models in record['usage'].values() for m,u in models.items() if m == model)
                    self.assertEqual(actual, processed)
                for model, aux in expected.get('auxProcessed', {}).items():
                    ledger = record['ledger']['models'][model]
                    delta = ledger['in'] + ledger['out'] + ledger['cacheWrite'] - expected['processed'][model]
                    self.assertEqual(max(0, delta), aux)
                    if model in expected.get('ledgerLag', {}):
                        self.assertEqual(delta < 0, expected['ledgerLag'][model])
                for agent_id, agent in expected.get('agents', {}).items():
                    for key, value in agent.items():
                        self.assertEqual(record['agents'][agent_id][key], millis(value) if key == 'firstSeenAt' else value)
        self.assertEqual(len(records), 3)

    def test_project_totals_and_mod_priority(self):
        sessions = load_project(self.root, [self.slug], None, None)
        expected = self.expected['project']
        self.assertEqual(len(sessions), expected['sessions'])
        for key in ('processed','cacheRead','requests','usdTotal'):
            self.assertAlmostEqual(sum(s[key] for s in sessions), expected[key])
        shutil.copytree(self.data / 'mod-runs' / 'runs', self.root / 'runs')
        sessions = load_project(self.root, [self.slug], None, None)
        self.assertEqual(sum(s['processed'] for s in sessions), expected['processed'])
        self.assertEqual(sessions[0]['source'], 'mod')
        self.assertEqual(load_project(self.root, ['absent']), [])
        self.assertEqual(load_project(self.root, [self.slug], '2030-01-01T00:00:00Z'), [])

    def test_streaming_large_transcript_and_ring(self):
        config = self.base / 'large-config'
        path = config / 'projects' / 'project' / 'large.jsonl'
        path.parent.mkdir(parents=True)
        with path.open('w', encoding='utf-8') as handle:
            for index in range(2500):
                row = dict(type='assistant', timestamp=self.expected['now'], cwd='project', message=dict(model='model-1', content=[dict(type='text', text='x'*2200)], usage=dict(input_tokens=1, output_tokens=2, cache_read_input_tokens=3, cache_creation_input_tokens=4)))
                handle.write(json.dumps(row)+'\n')
            handle.write(json.dumps(dict(type='cost-state', startTime=1, totalCostUSD=0))+'\n')
        self.assertGreater(path.stat().st_size, 5*1024*1024)
        # 파일 전체 읽기 API를 호출하면 실패한다.
        with patch.object(Path, 'read_text', side_effect=AssertionError('전체 읽기 금지')), patch.object(Path, 'read_bytes', side_effect=AssertionError('전체 읽기 금지')):
            result, code = backfill([config], self.root, now=self.expected['now'])
        self.assertEqual((code, result['written']), (0, 1))
        record = read_json(self.root / '_backfill' / 'project' / 'large' / 'backfill.json')
        self.assertEqual(record['usage']['main']['model-1'], dict(zip(('in','out','cacheRead','cacheWrite','steps','nullUsageSteps'), (2500,5000,7500,10000,2500,0))))
        self.assertEqual(len(record['steps']), 2000)
        self.assertEqual(record['run']['dropped']['steps'], 500)

    def test_external_usage_and_matching(self):
        sessions = load_project(self.root, [self.slug])
        runs = codex_usage(self.data / 'codex', [self.slug], None, None, sessions)
        expected = self.expected['codex']
        self.assertEqual(len(runs), expected['runs'])
        run = runs[0]
        for key in ('tokens','requests','model'):
            self.assertEqual(run[key], expected[key])
        self.assertEqual(run['matchedSession'], expected['matchedSessionIndex'])
        for key in ('startedAt','endedAt'):
            self.assertEqual(run[key], millis(expected[key]))
        self.assertEqual(codex_usage(self.base / 'absent', [self.slug]), [])
        self.assertEqual(codex_usage(self.data / 'codex', [self.slug], '2030-01-01T00:00:00Z'), [])

    def test_insights_allowlist(self):
        result = insights_for(self.configs, list(self.expected['sessions']))
        for sid, sections in self.expected['insights'].items():
            for section, values in sections.items():
                for key, value in values.items():
                    self.assertEqual(result[sid][section][key], value)
        for data in result.values():
            self.assertLessEqual(set(data['meta']), set(META_KEYS))
            self.assertLessEqual(set(data['facets']), set(FACET_KEYS))
        self.assertEqual(insights_for([self.base / 'absent'], ['absent']), {})
        self.assertEqual(insights_for(self.configs, ['../outside']), {})

    def test_overlap_cli(self):
        for name, expected in self.expected['overlap'].items():
            root = self.base / name
            shutil.copytree(self.data / name, root)
            shutil.copytree(self.root / '_backfill', root / '_backfill')
            result, code = overlap(root, [self.slug], 1)
            for key, value in expected.items():
                self.assertEqual(result[key], value)
            self.assertEqual(code, int(expected['diffs'] > 0))
            cli_code, cli_result, _ = self.invoke(['overlap','--root',str(root),'--min','1'])
            self.assertEqual(cli_code, code)
            self.assertEqual(cli_result, result)
            self.assertEqual(overlap(root)[1], 1)

    def test_privacy_all_commands_and_write_boundary(self):
        args = ['--root', str(self.root), '--config', str(self.configs[0]), '--config', str(self.configs[1])]
        for command in ('backfill','codex','insights','overlap','aar','summary','ledger','compact'):
            extra = []
            if command == 'backfill':
                extra = ['--now',self.expected['now']]
            elif command == 'codex':
                extra = ['--codex-dir',str(self.data / 'codex'),'--project',self.slug]
            elif command == 'insights':
                extra = ['--session',next(iter(self.expected['sessions']))]
            code, result, output = self.invoke([command] + args + extra)
            if command in ('backfill', 'codex', 'insights'):
                self.assertEqual(code, 0)
            if command == 'codex':
                self.assertEqual(len(result), self.expected['codex']['runs'])
            self.assertNotIn(self.expected['forbiddenMarker'], output)
            self.assertNotIn('/tmp/proj', output)
        for path in self.root.rglob('*.json'):
            output = path.read_text(encoding='utf-8')
            self.assertNotIn(self.expected['forbiddenMarker'], output)
            self.assertNotIn('/tmp/proj', output)
        self.assertFalse(any(self.data.rglob('backfill.json')))
        with self.assertRaises(ValueError):
            atomic_json(self.root, self.base / 'escape.json', {})
        self.assertFalse((self.base / 'escape.json').exists())

    def test_boundary_symlink(self):
        outside = self.base / 'outside'
        outside.mkdir()
        root = self.base / 'linked-output'
        root.mkdir()
        try:
            (root / '_backfill').symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('심볼릭 링크를 만들 수 없는 환경')
        with self.assertRaises(ValueError):
            backfill(self.configs, root, now=self.expected['now'])
        self.assertEqual(list(outside.iterdir()), [])

    def test_defaults_and_folder_entry(self):
        env = dict(HOME=str(self.base / 'home'), USERPROFILE=str(self.base / 'fallback'), DEBRIEF_DIR=str(self.root))
        with patch.dict(os.environ, env, clear=True):
            code, result, _ = self.invoke(['insights','--session','absent'])
            self.assertEqual((code, result), (0, {}))
            from paths import home
            self.assertEqual(home(), self.base / 'home')
            del os.environ['HOME']
            self.assertEqual(home(), self.base / 'fallback')
        proc = subprocess.run([sys.executable, str(ENTRY), 'overlap','--root',str(self.root),'--min','0'], capture_output=True, text=True, encoding='utf-8', env={**os.environ, **env})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(proc.stdout.splitlines()[-1].startswith('RESULT '))

    def test_last_chunk_null_and_independent_unkeyed_requests(self):
        path = self.base / 'project' / 'session.jsonl'
        path.parent.mkdir()
        rows = [
            dict(type='assistant', requestId='r', message=dict(id='m', model='model-1', usage=dict(input_tokens=90))),
            dict(type='assistant', requestId='r', message=dict(id='m', model='model-1')),
            dict(type='assistant', message=dict(model='model-1', usage=dict(input_tokens=2))),
            dict(type='assistant', message=dict(model='model-1', usage=dict(input_tokens=3))),
            dict(type='cost-state', startTime=1, totalCostUSD=1),
            dict(type='assistant', requestId='r2', message=dict(id='m2', model='model-1', usage=dict(output_tokens=4))),
        ]
        with path.open('w', encoding='utf-8') as handle:
            for row in rows:
                handle.write(json.dumps(row) + '\n')
        record, closed, bad = parse_session(path)
        self.assertFalse(closed)
        self.assertEqual(bad, 0)
        self.assertEqual(record['usage']['main']['model-1'], {'in':5, 'out':4, 'cacheRead':0, 'cacheWrite':0, 'steps':4, 'nullUsageSteps':1})

    def test_common_option_positions_and_default_root(self):
        config = self.base / 'empty-config'
        with patch.dict(os.environ, {'HOME': str(self.base), 'USERPROFILE': str(self.base)}, clear=True):
            code, result, _ = self.invoke(['--config', str(config), 'backfill', '--config', str(self.configs[0]), '--config', str(self.configs[1]), '--now', self.expected['now']])
        self.assertEqual((code, result['written']), (0, 3))
        self.assertEqual(len(list((config / 'debrief' / '_backfill').glob('*/*/backfill.json'))), 3)

    def test_exclusion_idempotence_and_optional_errors(self):
        sid = next(iter(self.expected['sessions']))
        result, code = backfill(self.configs, self.root, exclude_sessions=[sid], now=self.expected['now'])
        self.assertEqual(code, 0)
        self.assertEqual(result['written'], 2)
        self.assertIn('excluded', [s['reason'] for s in result['skipped']])
        first = {p: p.read_bytes() for p in self.root.rglob('*.json')}
        backfill(self.configs, self.root, now=self.expected['now'])
        self.assertEqual(first, {p:p.read_bytes() for p in self.root.rglob('*.json')})
        self.assertEqual(self.invoke(['aar','--root',str(self.root)])[0], 2)


if __name__ == '__main__':
    unittest.main()


class SharedProjectsDirTest(unittest.TestCase):
    def test_symlinked_config_dirs_count_each_session_once(self):
        import os, shutil, tempfile
        from backfill import backfill
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(Path(__file__).parent / 'fixtures' / 'cfg-a', Path(tmp) / 'cfg-a')
            (Path(tmp) / 'cfg-link').mkdir()
            try:
                os.symlink(Path(tmp) / 'cfg-a' / 'projects', Path(tmp) / 'cfg-link' / 'projects', target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('symlinks unavailable')
            result, code = backfill([Path(tmp) / 'cfg-a', Path(tmp) / 'cfg-link'], Path(tmp) / 'root', days=3650, idle_minutes=0)
            self.assertEqual(code, 0)
            self.assertEqual(result['duplicateDirs'], 1)
            self.assertEqual(result['found'], 3)
            self.assertEqual(result['written'], len(list((Path(tmp) / 'root' / '_backfill').rglob('backfill.json'))))
