"""폴더 실행 진입점과 공통 옵션."""
import argparse
import json
import os
import sys
from pathlib import Path
from paths import home
from backfill import backfill
from codex import codex_usage
from insights import insights_for
from model import load_project, overlap


def main(argv=None):
    parser = argparse.ArgumentParser()
    def common(p, suppress=False):
        default = argparse.SUPPRESS if suppress else None
        p.add_argument('--root', default=default)
        p.add_argument('--config', action='append', default=default)
    common(parser)
    subs = parser.add_subparsers(dest='command', required=True)
    for name in ('backfill','codex','insights','overlap','aar','summary','ledger','compact'):
        p = subs.add_parser(name)
        common(p, True)
        if name in ('backfill','codex','overlap','aar'):
            p.add_argument('--project', action='append', default=[])
        if name == 'backfill':
            p.add_argument('--days', type=float, default=30)
            p.add_argument('--idle-minutes', type=float, default=60)
            p.add_argument('--exclude-session', action='append', default=[])
            p.add_argument('--now')
        elif name == 'codex':
            p.add_argument('--codex-dir')
            p.add_argument('--from', dest='t0')
            p.add_argument('--to', dest='t1')
        elif name == 'insights':
            p.add_argument('--session', action='append', required=True)
        elif name == 'aar':
            p.add_argument('--title')
            p.add_argument('--from', dest='t0')
            p.add_argument('--to', dest='t1')
            p.add_argument('--cards')
            p.add_argument('--profile')
            p.add_argument('--codex-dir')
            p.add_argument('--tz')
            p.add_argument('--no-ledger', action='store_true')
            p.add_argument('--out', required=True)
        elif name == 'summary':
            p.add_argument('--session', required=True)
            p.add_argument('--threshold-share', type=float, default=.10)
            p.add_argument('--threshold-min', type=float, default=10)
            p.add_argument('--profile')
            p.add_argument('--codex-dir')
            p.add_argument('--out', required=True)
        elif name == 'ledger':
            actions = p.add_subparsers(dest='action', required=True)
            listing = actions.add_parser('list')
            listing.add_argument('--status', choices=('proposed','applied','verified','dropped'))
            setting = actions.add_parser('set')
            setting.add_argument('ident')
            setting.add_argument('status', choices=('proposed','applied','verified','dropped'))
        elif name == 'compact':
            p.add_argument('--days', type=float, default=30)
            p.add_argument('--now')
            p.add_argument('--dry-run', action='store_true')
            p.add_argument('--delete-archives-before')
            p.add_argument('--yes', action='store_true')
        elif name == 'overlap':
            p.add_argument('--min', type=int, default=3, dest='minimum')
    try:
        # 옵션처럼 보이는 slug도 값으로 받는다. 공통 옵션은 위치와 무관하다.
        raw = list(sys.argv[1:] if argv is None else argv)
        shared, local = [], []
        i = 0
        while i < len(raw):
            token = raw[i]
            if token in ('--root', '--config', '--project') and i + 1 < len(raw) and not raw[i + 1].startswith('--'):
                target = shared if token in ('--root', '--config') else local
                target.append(token + '=' + raw[i + 1])
                i += 2
            elif token.startswith(('--root=', '--config=')):
                shared.append(token)
                i += 1
            else:
                local.append(token)
                i += 1
        args = parser.parse_args(shared + local)
        configs = args.config or [os.environ.get('CLAUDE_CONFIG_DIR') or home() / '.claude']
        root = Path(args.root or os.environ.get('DEBRIEF_DIR') or Path(configs[0]) / 'debrief')
        if args.command == 'backfill':
            result, code = backfill(configs, root, args.days, args.idle_minutes, args.project, args.exclude_session, args.now)
        elif args.command == 'codex':
            result = codex_usage(args.codex_dir or home() / '.codex' / 'sessions', args.project, args.t0, args.t1, load_project(root, args.project, args.t0, args.t1))
            code = 0
        elif args.command == 'insights':
            result, code = insights_for(configs, args.session), 0
        elif args.command == 'overlap':
            result, code = overlap(root, args.project, args.minimum)
        elif args.command == 'aar':
            from aar import aar
            result, code = aar(args, root, configs)
        elif args.command == 'summary':
            from summary import summary
            result, code = summary(args, root)
        elif args.command == 'ledger':
            from ledger import command
            result, code = command(root, args.action, getattr(args, 'ident', None), args.status)
        elif args.command == 'compact':
            from compact import compact
            result, code = compact(root, args.days, args.now, args.dry_run, args.delete_archives_before, args.yes)
    except SystemExit as exc:
        result, code = dict(error='사용법 오류'), exc.code
    except (OSError, ValueError, TypeError, KeyError):
        result, code = dict(error='입력 또는 출력 오류'), 2
    print('RESULT ' + json.dumps(result, ensure_ascii=False, allow_nan=False))
    return code


if __name__ == '__main__':
    sys.exit(main())
