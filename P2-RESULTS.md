# debrief P2 결과 — 리포트 프로그램 · 백필 · 프로젝트 AAR

> **결론:** 완료 기준 6개 모두 PASS. 리포트 프로그램(`debrief/tools/debrief_report/`, Python 표준 라이브러리만)과 mod 래퍼(`/debrief aar|backfill|compact|ledger`)가 합성 픽스처와 실데이터 양쪽에서 동작한다. 실데이터 백필은 최근 30일 525세션을 16초에 썼고, mod 기록과 백필이 겹치는 5세션이 루프별·모델별 카운터까지 전부 일치했다. 첫 실데이터 AAR은 `.local/aar/2026-10-15-debrief-p0p1.html`(git 밖)에 있다. Codex 3묶음은 모두 채택했고, Claude 리뷰에서 수정 10건을 반영했다(보류 0, 스펙 한계로 넘긴 것 1).

## 1. 완료 기준

| 기준 | 판정 | 근거 |
|---|---|---|
| 백필: 30일 세션당 1파일, 수 출력, 불일치 exit≠0, 건너뛴 사유 | PASS | 두 config(`~/.claude`, `~/.claude-alt`) 538 발견 · 525 종료 · 525 기록 · 건너뜀 13(열림 12, 제외 1), badLines 0, 중복 config 1(심볼릭 링크), 약 16초. 불일치 exit≠0은 테스트로 확인 |
| 픽스처 3개 모델별 4카운터 정확 일치 | PASS | F1·F2·F3 손 계산 `expected.json`과 in·out·cacheRead·cacheWrite·요청 수 일치(`test_fixture_counts_and_metadata`). 프로젝트 합 처리 토큰 966, 캐시 읽기 1894, 요청 10, USD 0.45 |
| 겹침 검사 ≥3세션 정확 일치 | PASS | P1 실세션 mod 기록 5세션 대 백필: 비교 5 · 일치 5 · diff 0(2회 측정, 백필 갱신 후 재측정 동일) |
| 리포트 테스트: 기대 합계 문자열, 허용 목록 밖 필드 0 | PASS | `test_report_totals_privacy_and_cards` 외: 허용 키 경로 집합 밖 키는 개발 모드 예외, 실행 시 제거. 금지 표식·경로·UUID·slug·요청 ID 문자열 0 |
| 첫 실데이터 AAR | PASS | `.local/aar/2026-10-15-debrief-p0p1.html` 41 KB, 35세션(백필 30 · mod 5), Codex 2실행 짝지음. 금지 패턴 0, 외부 리소스 0, 360px 가로 넘침 없음, 콘솔 오류 0(브라우저 확인). 4카드·개선 2건은 `.local/aar/cards-p0p1.json`(리뷰 세션 작성) |
| S19 폴더 밖 변경 0 · 테스트 통과 | PASS | P2 작업의 폴더 밖 변경 0. Python unittest 36건, `claude plugin test debrief` 36건, `tsc -p debrief` exit 0, `claude plugin validate debrief` 통과. NOTE: 같은 시간대에 형제 폴더 2개(17:23·17:32 생성)가 생겼으나 이 폴더 세션 기록에는 흔적이 없는 다른 세션 산출물이다 |

## 2. 명령 목록

```
# 테스트
cd debrief/tools/debrief_report && python3 -m unittest discover -s tests       # 36 OK
claude plugin validate debrief && claude plugin test debrief                   # 36 pass
node <typescript 5.7>/bin/tsc -p debrief                                       # exit 0

# 실데이터(전부 .local 안)
python3 debrief/tools/debrief_report backfill --config ~/.claude --config ~/.claude-alt \
  --root .local/p2-root --days 30 --exclude-session <현재 세션>
python3 debrief/tools/debrief_report overlap --root .local/p2-root
python3 debrief/tools/debrief_report backfill ... --project <이 폴더 slug> --days 2 --idle-minutes 15
python3 debrief/tools/debrief_report aar --project <이 폴더 slug> --title "debrief P0·P1" \
  --from 2026-10-15T15:00:00+09:00 --to 2026-10-15T16:28:00+09:00 \
  --cards .local/aar/cards-p0p1.json --profile .local/aar/profile-p0p1.json \
  --codex-dir ~/.codex/sessions --config ~/.claude --root .local/p2-root --tz +09:00 \
  --out .local/aar/2026-10-15-debrief-p0p1.html
python3 debrief/tools/debrief_report summary --root .local/p2-root --session <S1> --out .local/aar/summary-s1.html
python3 debrief/tools/debrief_report compact --root .local/p2-compact-test --days 7   # 사본에서만

# mod 래퍼(실제 CLI, 플러그인 폴더 직접 로드)
DEBRIEF_DIR=$PWD/.local/p2-root claude --plugin-dir ./debrief -p "/debrief ledger list"
DEBRIEF_DIR=$PWD/.local/p2-root claude --plugin-dir ./debrief -p "/debrief aar --from ... --to ... --cards .local/aar/cards-p0p1.json"
DEBRIEF_DIR=$PWD/.local/p2-root claude --plugin-dir ./debrief -p "/debrief compact --yes"   # 거부 문구 확인
```

compact 실데이터 시험(`.local` 안 사본): 343 run을 월별 rollup 4개로 접은 뒤 531세션의 처리 토큰 243,662,784 · 요청 42,431 · 캐시 읽기 · USD가 전후 동일, 재실행 대상 0(멱등), 용량 10 MB에서 3.7 MB.

## 3. Codex 묶음별 리뷰

| 묶음 | 커밋 | 판정 | 리뷰 수정 |
|---|---|---|---|
| 1. backfill·codex·insights·overlap | `d857e3e` | 채택 | (1) `~/.claude-alt/projects`가 `~/.claude/projects`의 심볼릭 링크라 세션이 두 번 세어짐(1076 대 525) — 수 검사가 이를 못 잡았다. 실제 경로 기준 중복 제거 + `duplicateDirs` + 회귀 테스트. (2) effort 값 허용 목록 검사 |
| 2. aar HTML·export·ledger·summary | `4cf41fd` | 채택 | (1) Codex 짝짓기를 "가장 가까운 시작"에서 위임 창 > 시간 포함 > 5분 유예 순으로(실데이터에서 오짝 발견). (2) 요청·메시지 ID 금지 패턴이 픽스처 접두어에만 맞던 것을 일반화. (3) 서머리에 G2 "보조·압축" 칸 추가. (4) 묶음 1 커밋에 들어간 `__pycache__` 추적 해제 |
| 3. compact·mod 래퍼·slugOf | `dd3e924` | 채택 | (1) aar가 세션마다 프로젝트 전체를 다시 읽던 것(O(n²))을 1회로. (2) `--cards` 상대 경로가 데이터 루트 기준으로 풀리던 것을 세션 cwd 기준으로. (3) 히어로에 "장부 없는 세션 n개는 0으로 셈" 표기. (4) 빈 insights 칸 정리 |

넘긴 것(보류 아님, 스펙 한계): 백필 `attribution`에 모델 키가 없어, cwd 범위가 시간상 겹치면 서머리의 모델별 값이 "미분류 모델(추정)"이 된다. Codex가 지적했고 P3 스키마 후보로 둔다.
Codex 확인 요청: 부분 압축 시 같은 출처의 raw와 rollup을 runId 중복 없이 합산하는 적재 규칙 — 테스트와 실데이터 합계 동일로 확인, 채택.

## 4. 겹침 검사 수치(루프·모델별 [in, out, cacheRead, cacheWrite, 요청])

| 세션 | 루프 | 모델 | mod = 백필 |
|---|---|---|---|
| S1 | main | sonnet | [10, 273, 255011, 53207, 5] |
| S1 | agent | haiku | [4, 209, 40424, 43284, 2] |
| S2 | main | haiku | [2, 80, 31052, 30964, 1] |
| S3 | main | haiku | [2, 3, 31052, 30842, 1] |
| S4 | main | sonnet | [10, 305, 242207, 57554, 5] |
| S4 | agent | haiku | [4, 91, 38403, 41265, 2] |
| S5 | main | sonnet | [2, 3, 28295, 30973, 1] |

## 5. 첫 실데이터 AAR에서 본 갭

1. **가장 큰 세션의 비용이 비어 있다.** P0·P1 실행 메인 세션(S1, 처리 토큰 613,951, 전체의 35%)은 transcript에 cost-state가 없어 USD가 0으로 셈해진다. 히어로 $2.35는 S1을 뺀 값이다(이번에 히어로에 "장부 없는 세션 1개" 표기를 넣었다). mod가 켜진 세션만 장부가 정확하다.
2. **자동 보조 세션이 목록을 부풀린다.** 35세션 중 22개가 15:25–15:28의 sdk-cli 단발 haiku 세션, 2개가 sdk-py 세션이다. 프로젝트 작업이 아니라 다른 플러그인의 자동 호출로 보인다. 진입점(surface)으로 접거나 거를 수 있다.
3. **부모 열이 전부 비어 있다.** S30–S34(P1 실측용 자식 세션)는 S1이 띄웠지만 부모 표식이 없다 — 개선 항목 1번(`i-20261015-dbd865`)과 같은 갭.
4. **기간 창이 세션을 자르지 않는다.** `--to 16:28`이어도 S1은 17:05까지(후속 활동) 그대로 들어가 기간 끝이 17:05로 나온다. 창은 세션 선택에만 쓰인다.
5. **열린 세션 판정이 mtime 기준이라 유휴 시간에 민감하다.** 기본 60분이면 S1이 "열림"으로 빠져, 이번엔 `--idle-minutes 15`로 넣었다.
6. Codex 짝짓기는 위임 창(`externalAgentTypes`)이 있으면 정확했다(X1은 S3, X2는 S1 — 둘 다 그 세션의 위임 에이전트 창 안). 프로필이 없으면 "시간 포함, 늦게 시작한 세션" 규칙으로 떨어진다.
7. insights(`usage-data`)는 오늘 세션에 데이터가 없어 보조 열이 비었다.

## 7. Codex 리뷰 — 리뷰 수정 10건의 교차 벤더 1차 리뷰

범위는 수정 10건의 발췌(`.local/review/reviewer-fixes.md`, 113줄)와 해당 함수로 한정했다. 결과: 문제 없음 5(F2 effort 검사, F5 서머리 보조·압축, F6 `__pycache__`, F7 1회 적재, F10 빈 insights 칸), 지적 5. 지적 5건 중 채택 4, 보류 1(코드 유지, 스펙 갱신).

| 지적 | 등급 | 판정 | 처리 |
|---|---|---|---|
| F1 백필 중복 제거: 같은 세션의 오래된 사본이 먼저 보이면 뒤의 새 사본을 놓친다 | high | 부분 채택 | 기간 안에 든 사본만 "본 세션"으로 표시하도록 순서를 바꿈 + 회귀 테스트. "서로 다른 세션이 합쳐진다"는 부분은 보류: sessionId가 UUID라 같은 slug·ID면 같은 세션의 사본이다 |
| F3 Codex 짝짓기가 스펙 4.1(시작이 가장 가까운 세션)과 다르다 | medium | 보류(코드 유지) | 실데이터에서 기존 규칙이 위임하지 않은 세션에 붙였기 때문에 바꾼 것이다. 스펙 4.1을 현재 규칙(위임 창, 시간 포함, 5분 유예)으로 갱신 |
| F4 ID 금지 패턴이 `msg_status` 같은 평범한 낱말까지 지운다 | medium | 채택 | `req_ msg_ toolu_ resp_ call_` 뒤에 숫자가 섞인 12자 이상만 ID로 판정 + 테스트(평범한 낱말 유지, `msg_bdrk_…`·`msg_vrtx_…`·`req_011…` 등 제거). 처음엔 `_0` 접두로 좁혔다가 커밋 보안 리뷰가 클라우드 경유 ID 형식 누락(제거 후퇴)을 지적해 다시 넓힘 |
| F8 `--cards C:cards.json`(드라이브 상대 경로)을 절대 경로로 취급 | medium | 채택 | 드라이브 상대 경로는 거부, 절대 경로 판정은 `/`, `\`, `X:\`, `X:/`만 + 래퍼 테스트 |
| F9 히어로 문구 "장부 없는 세션은 0으로 셈"이 추정 정의(누락·음수 차이 포함)와 어긋남 | medium | 채택 | "비용 누락·음수 차이를 0으로 처리한 세션 n개"로 변경 |

반영 뒤: Python 38건, plugin test 36건, tsc exit 0.

## 6. P3 메모

- 진입점별 세션 접기(sdk-cli·sdk-py 단발 세션을 "자동 보조 n건"으로 묶기) — 갭 2.
- 백필 `attribution`에 모델별 분해 추가 — 서머리 미분류 모델 해소.
- 기간 창으로 세션 내부 요청까지 자르는 옵션(`--clip`) — 갭 4.
- 열린 세션 판정에 프로세스 생존(가능한 OS에서) 또는 마지막 줄 종류를 더하기 — 갭 5.
- 부모 세션 표식: 실측용 `claude -p`에 환경변수로 부모 ID 전달(P0 S12에서 기록 확인됨) — 개선 항목 1번.
- Windows 실행(`py -3` 경로)은 단위 테스트로만 확인, 실기기 미확인.
- 실데이터 시험 사본 `.local/p2-compact-test/`는 남겨 두었다(검증 근거, git 밖).

## 8. G3 수정 — AAR 화면 재작성(2026-10-15)

판정: 표 격자 위주라 도식이 부족하다. 예시 AAR(`lab/2026-10-15-aar-example.html`)의 시각 구조로 다시 만들었다.
- 위에서 아래로: 히어로 숫자 4개(처리 토큰·비용(API 환산)·작업 시간·세션 수)와 보조 타일 4개, 계획/실제/차이/개선 판정 카드(개선 항목마다 적용 프롬프트 복사 버튼), 위임 지도 SVG(세션 아래 서브에이전트·외부 실행, 시간축 겹침, 위임 시점 연결선), 대표 세션 타임라인 SVG(5분 묶음 누적 막대, 태그 띠, 압축·중단 표식), 루프별 모델 누적 막대 SVG와 외부 실행 별도 점선 막대, effort 분포, 마찰·정본 지문 배지, 선언 대 실제, 메타데이터 가설, 상세 격자는 전부 `<details>`.
- SDK 진입점의 5분 이하 단발 세션(서브에이전트 없음)은 "자동 보조 n건" 한 줄로 접는다. 실데이터에서 25건.
- 작업 시간은 세션 구간 합집합(겹침 포함 합은 부제).
- 백필이 압축 경계 시각(`events`)과 중단 요청 표식을 남기도록 보강.
- 확인: Python 38건 통과, 실데이터 AAR 재생성, 허용 목록 엄격 모드 통과, 금지 문자열 0, 360px 다크 모드 가로 넘침 없음, 콘솔 오류 0, 복사 버튼 동작.

**변형 비교 후 채택(2026-10-15 18:35):** 세 변형(main 재작성, astra, fable) 비교에서 astra 렌더링(`aar_visuals.py`, `templates/aar.js`, `templates/aar.css`)을 채택해 병합했다(`e465d8f`). 위 재작성의 화면 코드는 제거했고, 데이터 쪽 개선은 astra 위에 다시 얹었다: 자동 보조 규칙(SDK 진입점, 서브에이전트 없음, 요청 1회 또는 5분 이하), 히어로 작업 시간 = 세션 구간 합집합(실데이터 122.3분, 겹침 포함 146.4분은 보조 줄), 선언 대 실제 main = 작업 세션 10(자동 보조 25건 별도), 백필 압축 시각을 타임라인 표식으로. 테스트 43건.
