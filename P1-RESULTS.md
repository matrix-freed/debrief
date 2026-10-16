# debrief P1 결과 — 기록기(MVP recorder)

> **결론:** `debrief/` mod(코어)가 완료 기준을 모두 통과했다. validate·tsc exit 0, 테스트 26건 통과(5회 반복 안정), 실세션의 모델별·루프별 사용량이 transcript와 4개 카운터·요청 수까지 정확히 일치했다(`/clear` 전후 2개 세션 포함). 폴더 밖 변경은 0건이다. P0 스키마 수정 6건은 모두 반영했다. Codex 1차 리뷰 7건 중 5건 채택·2건 부분 채택, 보류 0건(5절) — 반영 후 완료 기준을 처음부터 다시 돌렸다.

- 빌드: Claude Code 2.1.300, 2026-10-15
- 구조: `hooks/register.ts`(훅 배선·영속화·명령), `hooks/record.ts`(순수 기록 로직), `hooks/profile.ts`(프로필 기본값·정규화), `hooks/paths.ts`(경로, macOS·Linux·Windows), `hooks/insights.ts`(`/insights` 어댑터, fail-open), `types/index.d.ts`(계약), `schema/`(장부 스키마·중립 예시 프로필)
- `probe/`는 그대로 둔다(P0 기록용, 비활성)

## 1. 완료 기준 체크

| 기준 | 결과 | 근거 |
|---|---|---|
| `claude plugin validate debrief` exit 0, 훅 목록 일치 | PASS | 훅 17개(아래 2절). 자체 명령은 "answers its own command"로 인식 |
| `tsc -p debrief` exit 0 | PASS | strict, noUncheckedIndexedAccess. 엔진 타입은 `.claude-plugin/types/`(git 제외) |
| `claude plugin test debrief` | PASS | 26 pass / 0 fail, 5회 연속(리뷰 회귀 테스트 3건 포함) |
| — 혼합 모델 턴 | PASS | 한 턴 4요청(모델 2개, usage 없는 요청 1)을 모델별 4카운터로 정확히 분리 |
| — 완료만 있는 에이전트 | PASS | `turn.complete`만 온 에이전트도 항목 생성(turns 1, startedAt 없음) |
| — 중복/재생 spawn | PASS | 같은 agentId spawn 2회: spawnAttempts 2, 사용량 중복 없음, 외부 위임 1회만 |
| — 재개 에이전트 | PASS | `resume` 있는 spawn은 resumed true |
| — 거부 spawn | PASS | spawnDenied 1, 에이전트 항목 없음 |
| — `/clear` 회전 | PASS | 이전 run endReason clear, 새 세션 id로 새 run(rotatedFrom), 사용량 분리 |
| — 재개 시 새 run 파일 | PASS | 끝난 run 뒤 같은 세션 id로 시작하면 새 runId, 이전 파일 바이트 동일 |
| — 두 루프 동시 update | PASS | 주 루프·에이전트 step 16개 동시 실행, 합계 정확(`update()` 재시도) |
| — 쓰기 실패 | PASS | 실패 1회 기록, 다음 쓰기에 누적값 전부 |
| — 바이트 예산 | PASS | 예산 6,000 B: 파일 ≤ 예산, coverage partial, 버린 step 수 + 남은 step 수 = 60, 합계는 그대로 |
| — 프라이버시 | PASS | 표식 문자열을 턴 텍스트·spawn 프롬프트·도구 입력(경로 포함)·명령 인자·스킬 본문·세션 간 메시지·답변에 넣음 — 파일에 0건 |
| — 정본 지문 1건 이상 | PASS | `InstructionsLoaded`(세션 시작 전 버퍼 경유)와 `$.fs.ancestors` 스캔 둘 다. 해시만, 경로·본문 없음 |
| — 마찰 카운터 4종 | PASS | aborted 1, toolErrors 1, rejected 1, compactions 1. classic 이벤트가 없으면 앞 하나만 세고 나머지 셋은 null |
| — 프로필 없이 동작 | PASS | 환경변수는 HOME만, 프로필 없음 — 기본 폴더에 기록, profileSource default. HOME이 없으면 USERPROFILE(Windows 경로) |
| 실세션 대조 | PASS | 2절 아래 표. 리뷰 반영 후 다시 실행 |
| S19 폴더 밖 변경 0 | PASS | 실세션 3회 모두: 형제 저장소 3개 `git status` 전후 동일. 시작 이후 바뀐 폴더 밖 파일은 다른 세션의 메모리 플러그인 파일뿐(마지막 회차 0건) |

## 2. 훅 목록

`session.start`, `classic.SessionStart`, `classic.InstructionsLoaded`, `turn.start`, `turn.step`(async generator, `yield* next(e)`), `turn.complete`, `agent.spawn`, `tool.call`(관찰), `classic.PostToolUseFailure`, `classic.PreCompact`, `skill.prompt`(이름만), `command.run`(이름만), `command.run{debrief}`(자체 명령), `session.send`, `session.receive`, `session.measure`, `session.end`.

브리프 목록보다 둘이 많다. `classic.PostToolUseFailure`와 `classic.PreCompact`는 마찰 카운터의 toolErrors·rejected·compactions를 세는 데 필요하다. 모든 훅의 기록 작업은 오류 경계(`guard`) 안에서 돌고, 체인은 항상 `next`로 이어진다. 결과를 바꿀 수 있는 자리(gating)에 있는 관찰 훅에는 `.catch(($, e, next) => next(e))`도 달았다(자체 명령 `command.run{debrief}`는 제외 — 자기 명령에 직접 답하는 훅이다).

### 실세션 대조(이 폴더, tmux 자기 세션, 리뷰 반영 후 최종 코드)

시나리오: 1턴 → `/debrief tag` → Haiku 서브에이전트 1개 + Bash 오류 1건 → `/clear` → 1턴 → `/debrief` → 종료.

| 세션 | 루프 | 모델 | 입력 | 출력 | 캐시 읽기 | 캐시 쓰기 | 요청 | transcript와 |
|---|---|---|---|---|---|---|---|---|
| `/clear` 전 | main | Sonnet 5.5 | 10 | 305 | 242,207 | 57,554 | 5 | 일치 |
| `/clear` 전 | agent | Haiku 5.5 | 4 | 91 | 38,403 | 41,265 | 2 | 일치 |
| `/clear` 후 | main | Sonnet 5.5 | 2 | 3 | 28,295 | 30,973 | 1 | 일치 |

같은 실행의 기타 값: `/clear` 전 run은 endReason clear·턴 4·태그 `phase-c`(이후 턴에 표시)·friction toolErrors 1 rejected 0·tool.call main 2 agent 1 isError 1·정본 지문 2·비용 장부 0 → 0.28. `/clear` 후 run은 classic source clear·턴 1·지문 2. 표식 문자열 0건. 상태줄은 `debrief: in 59k out 3 · 0m · main 100%` 형태로 표시됐다. 리뷰 반영 전 코드의 실세션(Sonnet 5요청·Haiku 2요청)도 일치했다. `/clear` 회전의 `rotatedFrom` 기록은 Haiku 2턴 세션으로 따로 확인했다(아래 5절 추가 발견). 대조는 `scripts/p1-compare.py`(P0 방식 재사용, 불일치 시 exit 1)로 했다.

## 3. 스키마 v3(최종 필드)

run 파일: `<root>/runs/<project-slug>/<sessionId>/<runId>.json`. root는 `DEBRIEF_DIR`, 없으면 `<CLAUDE_CONFIG_DIR 또는 home/.claude>/debrief`. 쓸 때마다 파일 전체를 다시 쓴다.

| 필드 | 내용 |
|---|---|
| `schema` 3, `recorder`, `engine`, `source` | 버전 추적 |
| `project { slug, id? }` | slug = transcript 폴더 규칙. id는 `DEBRIEF_PROJECT`. 로컬 전용 |
| `sessionId`, `runId`, `parentSessionId?` | parent는 `DEBRIEF_PARENT_SESSION` |
| `run { startedAt, endedAt?, endReason?, rotatedFrom?, surface, isInteractive, reloads, lastCheckpointAt, coverage, dropped{steps,turns,agents} }` | 실행 단위 |
| `usage[loop][model] { in, out, cacheRead, cacheWrite, steps, nullUsageSteps }` | loop = `main` 또는 agentId. 모델은 요청(step) 단위 |
| `effort[model][effort]` | 요청 수 |
| `steps[]`, `turns[]` | 링 버퍼(프로필 한도). 턴에 `startedAt?`·`tag?` |
| `openTurns` | 진행 중인 턴의 시작 시각(완료 때 제거) |
| `cost { usdAtStart?, usdAtEnd?, at?, provenance }` | 엔진 장부, 세션 누적(수정 5) |
| `context { percent?, window? }` | |
| `agents[agentId] { subagentType?, model?, parentModel?, parentAgentId?, background?, fork?, teammate?, workflowRunId?, workflowIndex?, resumed, spawnAttempts, turns, durationMs, firstSeenAt, seen{start,steps,complete,spawn} }` | 첫 이벤트에서 만들고 spawn 정보를 병합(수정 1). background는 판정에 쓰지 않음(수정 2) |
| `spawnDenied`, `workflowRuns[]` | |
| `requestedToolCalls[loop][name]`, `serverToolUses[name]` | 요청 기준(실행 기준 아님) |
| `toolCalls { main, agent, isError, denied, reentry{} }` | tool.call 관찰(수정 4) |
| `classic { seen, sessionStartSources[], postToolUseFailures, interrupts, compactions }` | |
| `friction { aborted, toolErrors\|null, rejected\|null, compactions\|null }` | 쓰는 시점에 계산. rejected = isError − PostToolUseFailure. classic 미관측이면 null |
| `skills[name]`, `commands[name]` | 이름만 |
| `messaging { sent[originKind]{queued,refused}, received[originKind] }` | 본문 없음 |
| `delegation { external[subagentType], directives[label] }` | 둘 다 프로필이 정한 목록·패턴으로만 센다 |
| `tags[] { label, at, turnIndex }` | 유일하게 저장하는 입력 텍스트(자체 명령, 로컬 전용) |
| `instructions[] { memoryType, loadReason, pathHash, contentHash, bytes, mtimeMs }` | 정본 지문(수정 6) |
| `profileSource`, `writes { ok, failed, lastError? }` | |

프로필(`<root>/profile.json`, `$.store`의 `profile`): `language, aarUse, shareConsent, thresholdStyle, mainLane?, lanes, externalAgentTypes, directives[{label, pattern}], machines, limits{byteBudget, stepRing, turnRing, checkpointMs}`. 기본값은 중립(이름·패턴 없음)이다. 장부: `schema/ledger.schema.json`(id, lever, target, metric, status, applyPrompt, evidence?, 날짜) — 생성 로직은 P2.

## 4. G2 가정 중 코드에 박힌 지점

| 가정 | 위치 | 뒤집을 때 |
|---|---|---|
| 비용 = 엔진 장부(API 환산), 세션 누적 | `record.ts` `summaryText`의 문구, `register.ts` `session.measure`·`session.end`·`newRun` | 모델별 USD는 P2. 표기 문구만 바꾸면 됨 |
| 상태줄 = 합계만, 경고 없음 | `record.ts` `statusText` | 비용 추가 시 이 함수 한 곳 |
| 서브에이전트 설명 60자 = 저장 안 함 | `register.ts` `agent.spawn`가 `e.description`을 읽지 않음, `DebriefAgent`에 필드 없음 | 타입에 `descr60?` 추가 + `applySpawn` 입력 1줄 |
| narrate 자동화 없음 | `$.tool.register`·`$.model.complete` 미사용 | P2 래퍼에서 추가 |
| 리포트 = 별도 프로그램, mod는 요약만 | `/debrief`는 `summaryText`만 | P2가 `/debrief aar` 추가 |
| 배포 = 로컬 폴더 마켓플레이스 | `.claude-plugin/marketplace.json` | 공개 시 같은 파일을 GitHub 경로로 |
| 보관 = 30일 후 rollup(P2) | mod는 run 파일을 지우지 않음 | P2 compact 프로그램 |
| 체크포인트 30초·예산 3 MiB·링 2000/1000 | `profile.ts` `DEFAULT_PROFILE.limits` | 프로필 `limits`로 덮어씀 |

## 5. Codex 리뷰

Codex 1차 리뷰(읽기 전용, 입력은 `register.ts`·`types/index.d.ts`·이 문서로 한정) 7건. 채택 5, 부분 채택 2, 보류 0.

| # | 등급 | 지적 | 판정 | 반영 |
|---|---|---|---|---|
| 1 | high | `update()` 재시도 함수 안에서 모듈 카운터를 비워, 재시도 때 도구 카운트 유실 | 채택 | tool.call 카운트는 상태에 직접 기록. 재진입 카운트만 모듈에 모았다가 "고정 배치로 꺼내 → 실패 시 되돌림"(`foldReentry`). 회귀 테스트: 도구 호출 6건과 step 6건 동시 실행 → 정확 |
| 2 | high | `/clear` 신호와 주 루프 `turn.start`가 동시에 회전하면 run 2개 설치 | 채택 | 회전을 한 번에 하나로 직렬화하고 확인과 점유 사이에 `await`를 두지 않음. 추가 발견: `$.state.get`은 한 디스패치 안에서 같은 순간을 읽으므로, 설치된 run을 모듈 변수(`live`)로 추적. 회귀 테스트: 두 신호 동시 → run 2개(이전·새) |
| 3 | high | 관찰 훅 다수에 fail-open 처리가 없어 기록 실패가 체인을 끊을 수 있음 | 부분 채택 | 엔진 명세상 실패한 훅은 건너뛰고 체인은 계속되므로 "실행 중단"은 과장. 다만 `session.start`가 중간에 실패하면 명령 등록이 빠지는 문제는 실재 — 모든 기록 작업을 `guard`로 감싸고 명령 등록을 따로 분리 |
| 4 | medium | 쓰기 중 들어온 변경을 이전 스냅샷 기록 후 dirty 해제로 놓침 | 채택 | dirty 플래그를 세대 번호(`generation`/`writtenGeneration`)로 교체. 회귀 테스트: 쓰기 실패로 남은 변경이 다음 체크포인트에 기록됨 |
| 5 | medium | 지문 스캔 중 도착한 초기 이벤트가 버퍼에 남아 적용되지 않음 | 채택 | run을 먼저 설치하고 남은 버퍼를 고정 배치로 배출(`drainEarly`), 그 뒤 스캔 결과를 반영 |
| 6 | medium | 재로드 시 미반영 도구 카운트·dirty 상태 소실 | 부분 채택 | 도구 카운트는 #1로 해소. dirty는 재로드 때 `session.start`가 즉시 기록하므로 영향 없음. 재진입 카운트는 재로드 때 잃을 수 있음(드문 경우, 문서화) |
| 7 | low | 문서 서두가 아직 없는 리뷰 결과를 단정 | 채택 | 이 절 작성, 서두 수정 |

리뷰 반영 중 실세션에서 추가로 발견한 것: **엔진은 `/clear` 때 세션 범위 `$.state`를 비운다.** 그래서 새 run의 `rotatedFrom`이 빠졌다. 이전 run 정체를 모듈 변수에서 가져오도록 고친 뒤 실세션에서 확인했다.

## 6. P2에 넘길 메모

1. 대조 도구: `scripts/p1-compare.py <root>`가 run 폴더 전체를 transcript와 비교한다. P2 백필 파서의 회귀 검사로 그대로 쓸 수 있다.
2. 세션 요약은 같은 세션의 run 파일을 모두 읽어 합친다. 프로젝트 AAR은 `runs/<slug>/` 아래 세션 전체를 같은 방식으로 합치면 된다.
3. 마찰 rejected는 "도구 호출 오류 − PostToolUseFailure"로 계산한 근사값이다. 다른 플러그인이 거부한 호출은 `denied`에 따로 쌓인다.
4. 장부 USD와 step 합의 차이(보조 호출·압축)는 P0 S10대로 리포트에서 따로 표시한다. mod는 장부 값만 둔다.
5. 이 빌드에서 엔진은 `C:\…` 경로를 macOS에서 상대 경로로 해석한다. Windows 실기 검증은 파트원 PC로 한다(테스트는 경로 조립만 확인).
6. `$.state`는 한 디스패치 안에서 스냅샷이고 `/clear` 때 비워진다. 상태를 읽어 판단하는 코드(P2 래퍼 포함)는 이 두 성질을 전제로 짠다.
7. 개발 중 설치: 로컬 폴더 마켓플레이스 + `--scope local`. 실험이 끝나면 이 폴더 범위에서 비활성화해 두었다 — 다시 쓰려면 `claude plugin enable debrief@debrief-dev --scope local`.
