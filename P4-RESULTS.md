# debrief P4 결과 — 빈 AAR 카드는 질문 창으로

> **결론:** 할 일 5개를 모두 끝냈다. `--cards` 없이 AAR를 성공적으로 만들면 debrief가 모델 메모(질문 지시 + 그대로 실행할 재생성 명령)를 남기고, 질문 턴을 제출해 사람의 다음 입력 없이 AskUserQuestion이 뜨게 한다. `aar --no-ledger`를 허용한다. plugin 테스트 49건(기존 41 + 신규 8), Python 46건, tsc exit 0, validate 통과, precheck 0건. **실세션 확인은 아직 안 했다**(경계: `~/.claude` 쓰기·플러그인 설치 금지) — 4절.

## 1. 범위별 결과

| 항목 | 판정 | 내용 |
|---|---|---|
| 1. 카드 없는 AAR 뒤 질문 | PASS(단위) | `command.run` 응답 = RESULT 줄 + 사람용 한 줄, `context` = 모델 메모 1건. 대화형 + 사람 입력(`composer`·`bridge`)이면 `$.prompt.submit`으로 짧은 고정 문구를 제출해 턴을 시작한다 |
| 1. 카드 파일 위치 | PASS | `<root>/aar/<slug>/<stamp>.cards.json` — 같은 stamp의 HTML 옆. 레포·세션 폴더에 쓰지 않는다 |
| 1. 재생성 | PASS(단위) | 메모에 실제로 성공한 실행기(`python3` 또는 `py -3`)·프로그램 경로·고정 인자·사람이 준 인자 + `--cards <파일>`을 POSIX 따옴표로 담는다. 같은 `--out`이라 빈 HTML을 덮어쓴다. 성공하면 `open <html>` |
| 1. 묻지 않는 경우 | PASS | `--cards` 있음, exit≠0, RESULT에 `output` 없음, aar 외 하위 명령 |
| 1. 대체 경로 | PASS | 비대화형(-p) 세션과 사람이 아닌 출처(다른 플러그인의 `$.command.run`, 모델이 부른 경우)는 메모만 남기고 턴을 제출하지 않는다. 사람용 줄도 "…Claude에게 카드 작성을 요청하거나 --cards로 다시 생성하세요"로 바뀐다 |
| 2. `--no-ledger` | PASS | aar 전용 스위치(값 없음, 중복 불가), 프로그램과 재생성 명령에 그대로 전달. `compact`·`backfill`에서는 거부. 기본 동작 불변. Python은 이미 지원(기존 테스트 `test_bundle2` 264행) — 변경 없음 |
| 3. 기록 원칙 | PASS | 메모·제출 문구는 run 기록에 들어가지 않는다(기존 privacy 테스트 유지). 카드 파일 예외를 README 영·한에 한 줄씩 |
| 4. 테스트 | PASS | 아래 2절 |
| 5. 버전·문서 | PASS | 0.1.3(`.claude-plugin/marketplace.json`, `debrief/.claude-plugin/plugin.json`), README 명령 표·카드 문단·변경 내역(영·한), `SPEC-P4.md`, 이 문서 |

## 2. 테스트

신규 8건(`debrief/tests/report.test.ts`):

1. 카드 없이 만든 AAR → 사람용 줄, 메모 문구(질문·선택지·카드 경로·improvements 금지), 재생성 명령 전체 문자열, `open` 경로, 제출 1건(`origin: { kind: 'plugin', name: 'debrief' }`)
2. `--cards` 있음·backfill·compact·ledger → 메모·제출 없음
3. exit 2 실패 → 없음
4. exit 0이지만 RESULT에 `output` 없음 → 없음
5. 비대화형 → 메모만, 제출 없음
6. 다른 플러그인이 실행 → 메모만, 제출 없음
7. `--no-ledger` 전달·재생성 명령 포함·중복/값/다른 하위 명령 거부·`--cards`와 함께
8. 공백·작은따옴표가 든 데이터 루트의 셸 따옴표, `py -3` 대체 실행기가 재생성 명령에 실림

```
claude plugin test debrief                       # 49 pass (41 → 49)
cd debrief/tools/debrief_report && python3 -m unittest discover -s tests   # 46 OK (변경 없음)
node <typescript 5.9>/bin/tsc -p <scratch tsconfig: debrief/tsconfig.json + reference/claude-code.d.ts>   # exit 0
claude plugin validate debrief && claude plugin validate .   # 통과(아이콘 없음 경고는 기존)
python3 scripts/precheck.py                      # 0건
```

## 3. 설계 판단

- **훅 안에서 바로 submit할 수 없다(실측).** 테스트 엔진의 host check가 `command.run` 훅 안의 `$.prompt.submit`을 거부했다: `prompt.submit: called from a command.run hook, it would wait on the turn this hook is holding; submit from a later event (turn.complete) (host check)`. `await` 없이 불러도 같다. 로컬 명령은 `turn.complete`를 일으키지 않으므로 `$.clock.after(0, …)`로 훅이 끝난 뒤 제출한다(정본: "a call made after the hook returned (a later timer…)" 허용). 제출된 턴은 세션이 idle이 된 뒤 시작되므로 명령 출력·메모 다음에 온다.
- **숨김 불가.** `PromptSubmitArgs`는 `isMeta`를 빼고 있어 플러그인 제출은 "The debrief plugin sent a message: …" 행으로 보인다. 그래서 행 문구는 짧게(`AAR 리뷰 카드가 비어 있습니다. 직전 /debrief 메모대로 확인 창을 띄워 주세요.`) 두고, 긴 지시는 사람이 보지 않는 `context`에 둔다. `asUser`는 사람이 친 말처럼 보이므로 쓰지 않았다.
- **재진입 없음.** 재생성은 Claude가 Bash로 프로그램을 직접 돌리므로 debrief의 `command.run`을 다시 타지 않는다 — 질문이 반복되지 않는다.
- **사람 입력만 제출.** 모델이나 다른 플러그인이 명령을 부른 경우 이미 진행 중인 턴이 메모를 읽을 수 있어, 턴을 하나 더 만들면 질문이 두 번 뜰 수 있다. 그래서 출처가 `composer`·`bridge`일 때만 제출한다.

## 4. 확인 필요 (Oracle 실세션)

1. **실세션 동작.** 0.1.3 설치 뒤 대화형 세션에서 `/debrief aar` → (가) 사람용 줄 (나) "debrief 플러그인이 보낸 메시지" 행 (다) 곧바로 질문 창 (라) ① 선택 시 `<stamp>.cards.json` 생성·재생성·`open`. 특히 **메모(`context`)가 제출된 턴보다 먼저 모델에 보이는지** — 테스트 엔진은 순서까지는 보지 않는다. 안 보이면 모델이 재생성 명령을 모른다.
2. **실호스트의 `clock.after` 제출 허용.** 테스트 엔진은 허용했다. 실호스트가 거부하면 메모만 남는다(실패는 조용히 삼킨다 — 사람은 "확인 창을 띄웁니다" 문구만 보고 창이 안 뜰 수 있음).
3. **출처 값.** 모델이 Skill/SlashCommand로 `/debrief aar`를 부를 때 `origin.kind`가 `composer`가 아닌지. `composer`로 오면 질문이 두 번 뜰 수 있다.
4. **인자 없는 `/debrief`.** 코드상 이 경로는 `sessionSummary`만 돌려주고 리포트 프로그램을 실행하지 않는다(`register.ts` 632행). 10/29 실측의 `RESULT {"output": ".../aar/..."}`는 다른 경로(설치본 차이, 모델의 직접 실행 등)로 보이며 원인은 확인하지 못했다. 모델이 프로그램을 직접 돌린 경우에는 이번 변경으로도 질문이 나가지 않는다.
5. **Windows.** 재생성 명령은 POSIX 따옴표다. Windows의 Bash 도구가 PowerShell이면 따옴표가 맞지 않을 수 있다(미확인).
6. **언어.** 메모·문구는 지시대로 한국어 고정. 프로필 `language: en` 사용자도 한국어 지시를 받는다 — 필요하면 후속.

## 5. 경계

레포 워크트리와 스크래치패드(타입 검사용 tsconfig, 임시 백업) 밖은 건드리지 않았다. `~/.claude` 쓰기·플러그인 설치·main 머지·push·태그 없음. 프로세스 종료 없음.
