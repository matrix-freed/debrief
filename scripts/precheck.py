#!/usr/bin/env python3
"""Pre-publication check over every git-tracked file.

Categories:
  a  secrets      token / key shapes and password-like assignments
  b  names        company, project and people names from a local list
                  (default .local/precheck-names.txt, never tracked; missing = SKIP)
  c  identifiers  absolute home paths, real-looking UUIDs (session IDs), API request IDs
  d  local data   tracked files that belong to local or real data folders

A line that must keep a pattern on purpose (for example a detector's own regex)
carries the marker `precheck: allow` and is skipped. Synthetic test fixtures carry fake
paths and IDs by design, so categories c and d skip the fixture folder; a and b still apply.

Exit 0 when every category has 0 findings, 1 otherwise, 2 on usage errors.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ALLOW = 'precheck: allow'

SECRETS = [
    re.compile(r'sk-[A-Za-z0-9_-]{16,}'),
    re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{20,}'),
    re.compile(r'xox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[=:]\s*["\']?[^\s"\']{6,}'),
]

IDENTIFIERS = [
    re.compile(r'/Users/[^/\s\'"`]+'),  # precheck: allow (detector pattern)
    re.compile(r'/home/[^/\s\'"`]+'),  # precheck: allow (detector pattern)
    re.compile(r'(?i)[A-Z]:\\Users\\[^\\\s\'"`]+'),
    re.compile(r'\b(?:req|msg|toolu)_0[0-9A-Za-z]{10,}'),
]
UUID = re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', re.I)

LOCAL_PATHS = re.compile(r'(^|/)(\.local|\.remember|_backfill|data|runs|archive|profiles/local)/|profile\.local\.json$|\.aar\.html$|(^|/)rollup-\d{4}-\d{2}\.json$')
FIXTURES = 'debrief/tools/debrief_report/tests/fixtures/'


def synthetic_uuid(text):
    # Fixture IDs repeat a few digits (aaaaaaaa-0000-4000-8000-000000000001); real ones do not.
    return len(set(text.replace('-', '').lower())) <= 6


def name_patterns(path):
    patterns = []
    for raw in path.read_text(encoding='utf-8').splitlines():
        name = raw.strip()
        if not name or name.startswith('#'):
            continue
        if name.isascii():
            patterns.append((name, re.compile(r'(?<![A-Za-z0-9])' + re.escape(name) + r'(?![A-Za-z0-9])', re.I)))
        elif len(name) == 1:
            # A one-syllable surname also occurs inside ordinary words, so it counts only
            # as a standalone token or followed by a title.
            patterns.append((name, re.compile(r'(?<![가-힣])' + re.escape(name) + r'(?=팀장|님|성원|[^가-힣]|$)')))
        else:
            patterns.append((name, re.compile(re.escape(name))))
    return patterns


def tracked(root):
    out = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True, check=True).stdout
    return [p for p in out.decode('utf-8').split('\0') if p]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', default='.')
    parser.add_argument('--names', help='name list (default <root>/.local/precheck-names.txt)')
    parser.add_argument('--quiet', action='store_true', help='counts only, no matched text')
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    names_file = Path(args.names) if args.names else root / '.local' / 'precheck-names.txt'
    names = name_patterns(names_file) if names_file.is_file() else None

    findings = {'a': [], 'b': [], 'c': [], 'd': []}
    try:
        files = tracked(root)
    except (OSError, subprocess.CalledProcessError) as exc:
        print('git ls-files failed: %s' % exc, file=sys.stderr)
        return 2
    for rel in files:
        fixture = rel.startswith(FIXTURES)
        if not fixture and (LOCAL_PATHS.search(rel) or rel.endswith('.jsonl')):
            findings['d'].append((rel, 0, 'tracked local/real data path'))
        path = root / rel
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b'\0' in data[:8192]:
            continue
        for number, line in enumerate(data.decode('utf-8', errors='replace').splitlines(), 1):
            if ALLOW in line:
                continue
            for pattern in SECRETS:
                for m in pattern.finditer(line):
                    findings['a'].append((rel, number, m.group(0)))
            for pattern in () if fixture else IDENTIFIERS:
                for m in pattern.finditer(line):
                    findings['c'].append((rel, number, m.group(0)))
            for m in () if fixture else UUID.finditer(line):
                if not synthetic_uuid(m.group(0)):
                    findings['c'].append((rel, number, m.group(0)))
            for name, pattern in names or ():
                if pattern.search(line):
                    findings['b'].append((rel, number, name))

    labels = {'a': 'secrets', 'b': 'names', 'c': 'identifiers', 'd': 'local data'}
    total = 0
    for key in 'abcd':
        if key == 'b' and names is None:
            print('(%s) %s: SKIP (no name list)' % (key, labels[key]))
            continue
        items = findings[key]
        total += len(items)
        print('(%s) %s: %d' % (key, labels[key], len(items)))
        if not args.quiet:
            for rel, number, text in items:
                print('    %s:%d  %s' % (rel, number, text[:80]))
    print('files %d, findings %d' % (len(files), total))
    return 0 if total == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
