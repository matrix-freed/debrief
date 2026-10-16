"""HTML 경계의 명시적 키 경로 및 문자열 검사."""
import re
import sys

# 화면은 고정 구조의 섹션, 표, 카드, 차트만 받는다. 원본 객체는 전달하지 않는다.
ALLOWED_PATHS = frozenset('''title language sections sections[] sections[].title sections[].text sections[].kind sections[].headers sections[].headers[] sections[].rows sections[].rows[] sections[].rows[][] sections[].rows[][].value sections[].rows[][].estimated sections[].rows[][].basis sections[].cards sections[].cards[] sections[].cards[].title sections[].cards[].body sections[].cards[].evidence sections[].cards[].evidence[] sections[].cards[].prompt sections[].cards[].badge sections[].chart sections[].chart[] sections[].chart[].label sections[].chart[].value sections[].chart[].start sections[].chart[].end sections[].chart[].color axis axis.t0 axis.t1 axis.tickMs axis.bucketMs ticks ticks[] ticks[].at ticks[].label sections[].axis sections[].axis.t0 sections[].axis.t1 sections[].axis.tickMs sections[].axis.bucketMs sections[].ticks sections[].ticks[] sections[].ticks[].at sections[].ticks[].label'''.split())
ALLOWED_PATHS |= frozenset(('layout', 'sections[].chart[].group', 'sections[].chart[].detail', 'sections[].chart[].role', 'sections[].chart[].parent'))
ALLOWLIST = ALLOWED_PATHS
UNSAFE = re.compile(r'/Users/|/home/|/tmp/|[A-Za-z]:\\|~/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64,}|FORBIDDEN-MARKER-|\b(?:req|msg|toolu|resp|call)_(?=[A-Za-z_]*[0-9])[A-Za-z0-9_]{12,}|[\U0001f000-\U0001ffff\u2190-\u21ff\u2600-\u27bf\ufe0f]', re.I)  # precheck: allow (detector pattern)

def export(data, strict=False):
    def visit(value, path):
        if isinstance(value, dict):
            result = {}
            for key, child in value.items():
                p = path + '.' + key if path else key
                if p not in ALLOWED_PATHS:
                    if strict:
                        raise ValueError('허용되지 않은 내보내기 키: ' + p)
                    print('경고: 허용되지 않은 내보내기 키 제거', file=sys.stderr)
                    continue
                result[key] = visit(child, p)
            return result
        if isinstance(value, list):
            return [visit(child, path + '[]') for child in value]
        if isinstance(value, str) and UNSAFE.search(value):
            if strict:
                raise ValueError('민감한 내보내기 값')
            print('경고: 민감한 내보내기 값 제거', file=sys.stderr)
            return '[redacted]'
        return value
    return visit(data, '')


def safe_text(value):
    """장부에도 같은 값 검사를 적용한다."""
    if isinstance(value, str) and UNSAFE.search(value):
        print('경고: 민감한 선택 입력 값 제거', file=sys.stderr)
        return '[redacted]'
    if isinstance(value, dict):
        return {k: safe_text(v) for k,v in value.items()}
    if isinstance(value, list):
        return [safe_text(v) for v in value]
    return value
