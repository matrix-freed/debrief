# debrief P0 결과 — mod API 가정 실측

> **결론:** 필수 시나리오 15개(S1·S2·S3·S6·S7a·S7b·S7c·S9·S10·S11·S16·S17·S18·S19·PRIV) 모두 PASS, 필수 FAIL 0건. 스키마 v2는 유지하되 **6곳을 고친다**(아래 "스키마 v2 수정 제안"). 가장 큰 발견은 둘이다. (1) 이 빌드는 서브에이전트를 **항상 백그라운드로** 돌린다 — 포그라운드 경로가 없어 analysis §3.2의 재진입 우려(U3)가 사라졌다. (2) 사용자가 권한 대화상자에서 거부한 것은 `classic.PermissionDenied`로 잡히지 않는다 — `tool.call` 결과로 세야 하므로 "tool.call 훅 없음" 방침을 뒤집는다.

- 빌드: Claude Code 2.1.300, 2026-10-15 실측
- probe: `probe/`(버리는 코드, 메타데이터만 기록), 판정: `python3 scripts/p0-check.py` (exit 0)
- 설치: 로컬 폴더 마켓플레이스 + `--scope local` — 사람 확인 대화상자 없이 설치됐고, 열린 세션은 `/reload-plugins`로 폴더를 다시 읽었다
- 시나리오 세션: tmux로 띄운 이 폴더의 자기 세션 4개(대화형, Sonnet·Haiku) + `-p` 세션 23개. 실데이터 run 파일은 git 밖(`.local/`)

## 1. 시나리오 표

| ID | 필수 | 결과 | 근거(수치) |
|---|---|---|---|
| S1 | 예 | PASS | 주 루프 21개 요청: probe step 21 = transcript 요청 21(requestId+message.id 중복 제거), 모델별 4개 카운터 정확히 일치. 첫 2턴도 요청 단위로 일치 |
| S2 | 예 | PASS | spawn 3건, step의 agentId 집합 = spawn 결과 agentId 집합, 에이전트별 사용량 = 서브에이전트 transcript(각 2요청). **포그라운드 spawn 불가**: Agent 도구에 `run_in_background` 파라미터가 없고, 훅의 `background:false` 재작성 2회 모두 무시됨 |
| S3 | 예 | PASS | 3/3 백그라운드, 3/3 에이전트의 `turn.complete`가 그 에이전트를 띄운 주 턴이 끝난 뒤 도착 |
| S4 | 아니오 | PASS | `tool.call` 훅: 주 루프 10, 서브에이전트 4, re-entry 0. 백그라운드 전용이라 Agent 호출이 서브에이전트 실행을 감싸지 않음 |
| S5 | 아니오 | SKIPPED | Workflow는 사람의 "use a workflow" 지시가 필요 |
| S6 | 예 | PASS | `codex:codex-rescue` spawn 1건 기록(래퍼 모델 Sonnet), 기록된 사용량 모델은 전부 Claude. Codex 로그에 같은 시각·같은 폴더·`originator: Claude Code` 세션 1개, `token_usage_record` 2건 — 짝짓기 가능 |
| S7a | 예 | PASS | `/clear`: 이전 run `endReason: clear`, 새 세션 id로 새 run, 새 run의 classic SessionStart source = `clear` |
| S7b | 예 | PASS | 종료 후 `--resume`: 같은 세션 id 아래 새 runId 파일, 이전 파일 2개 바이트 동일(shasum) |
| S7c | 예 | PASS | `/reload-plugins` 3회: run 파일 1개 유지, reloads=3, 턴 15개·step 카운트 초기화 없음(`$.state`) |
| S8 | 아니오 | SKIPPED | 결정에 따라 생략(transcript `cost-state` 장부로 대체) |
| S9 | 예 | PASS | 같은 짧은 프롬프트 10회씩 교차: 턴 중앙값 2,658 ms(probe 있음) 대 2,608 ms(없음), +1.9%. 범위가 두 쪽 다 2.4~3.4 s라 차이는 잡음 수준 |
| S10 | 예 | PASS(차이 기록) | 아래 2절. 장부 USD = probe가 받은 `cost.usd`(0.6975 = 0.6975). 토큰은 장부가 step 합보다 큼(보조 호출), 단 Sonnet 캐시 쓰기는 장부가 19,091 작음 — 원인 미확정 |
| S11 | 예 | PASS | 보낸 쪽 `session.send` queued 1(origin `model`), 받는 쪽 `session.receive` 1(origin `peer`). 본문 미기록 |
| S12 | 아니오 | SKIPPED | Orca 워커는 띄우지 않음(Orca 상태 미접촉). 일반 자식 실행에 `DEBRIEF_PROJECT`·`DEBRIEF_PARENT_SESSION`을 주면 둘 다 기록됨 — Orca 상속 여부만 미검증 |
| S13 | 아니오 | PASS | 가짜 `: ssh remote-host tmux send-keys …`(셸 no-op) 1건 분류, Bash step 7건 중. 명령 본문 미저장. 단위 테스트 4건 통과 |
| S14 | 아니오 | PASS | `claude -p`에도 mod가 붙고 run 파일 생성(surface null, isInteractive false, endReason `other`) |
| S15 | 아니오 | PASS | session-meta 200개·facets 49개를 허용 목록 키만 읽어 집계, 자유 텍스트 필드 0건 출력. 폴더가 없으면 exit 0(fail-open). mod 쪽 `$.fs.list`도 200개 확인 |
| S16 | 예 | PASS | (a) 정본 지문 6건 — `$.fs.ancestors` + 사용자 CLAUDE.md 스캔(sha256 앞 16자가 실제 파일과 일치), `classic.InstructionsLoaded`(session_start·compact·include). (b) 중단 1, 도구 오류 1, 압축 1, 권한 거부 1(아래 3절). (c) `$.ui.status`가 상태줄 위에 `debrief-probe: probe 812k tok, main 79%` 형태로 표시, 27회 갱신 |
| S17 | 예 | PASS | 환경변수·프로필 없이 기본 폴더에 run 파일 생성(step 1). 확인 뒤 `.local/`로 옮기고 기본 폴더 삭제 |
| S18 | 예 | PASS | 등록 명령이 `$.ui.ask`로 구조화된 질문(선택지 2 + 직접 입력)을 띄우고 답을 run 파일과 `$.store`에 저장. `-p`에서는 거부(문서상) |
| S19 | 예 | PASS | 형제 저장소 3개 `git status` 전후 동일. 시작 이후 바뀐 폴더 밖 파일 14개는 모두 다른 세션의 메모리 플러그인 산출물. probe의 쓰기는 `$.fs.write` 하나(validate로 확인) |
| PRIV | 예 | PASS | 프롬프트·spawn 프롬프트·도구 입력·명령 인자·세션 간 메시지에 넣은 알려진 문자열이 run 파일 18개 어디에도 없음 |

## 2. S10 — step 합 대 엔진 장부

| 세션 | 모델 | 입력 (probe/장부) | 출력 | 캐시 읽기 | 캐시 쓰기 |
|---|---|---|---|---|---|
| 대화형(압축·에이전트 포함) | Haiku | 8 / 1,192 | 175 / 191 | 99,122 / 99,122 | 68,119 / 68,119 |
| 대화형 | Sonnet | 46 / 23,848 | 1,989 / 4,377 | 1,451,996 / 2,337,163 | 115,955 / 96,864 |
| `-p` 1턴 | Haiku | 2 / 2 | 84 / 84 | 11,091 / 11,091 | 27,847 / 27,847 |

- 보조 호출 없는 `-p` 세션은 완전히 일치한다. 대화형은 장부가 더 크다: 세션 제목·프롬프트 제안 같은 보조 호출(장부에만 있는 Haiku 입력 1,171)과 `/compact` 요약 요청은 `turn.step`을 거치지 않는다.
- Sonnet 캐시 쓰기만 장부가 작다(-19,091). transcript 합은 probe와 같으므로 장부 쪽 집계 방식 차이로 보이나 원인 미확정 — P2 파서가 세션 여러 개로 재검산한다.
- 장부 USD는 **세션 누적**이다: 재개한 run의 `cost.usd`가 이전 run 비용을 포함했다. run별 비용은 시작·끝 스냅샷의 차로 구해야 한다.
- transcript의 `cost-state` 줄은 대화형 세션이 살아 있는 동안은 없고, 종료·`/clear`·재개 시점에 쓰였다.

## 3. analysis §4 미검증 항목(U) 매핑

| U | 질문 | 결과 | 시나리오 |
|---|---|---|---|
| U1 | `$.fs.write`가 디렉터리를 만들며 쓰는가 | PASS | S14, S17 |
| U2 | 서브에이전트 `turn.step`에 agentId가 오는가 | PASS(백그라운드). 포그라운드는 이 빌드에 없음 | S2, S3 |
| U3 | 포그라운드 Agent 아래 `tool.call` 재진입 | 해당 없음 — 포그라운드 경로가 없음. 서브에이전트 도구 호출은 `tool.call` 훅에 도달, re-entry 0 | S4 |
| U4 | Workflow runId·agentIndex | SKIPPED(사람의 opt-in 필요) | S5 |
| U5 | 텔레메트리 탭 | 폐기 — S8 생략 결정, `cost-state` 장부로 대체 | S8 |
| U6 | `session.end` flush, `/clear`·재개·재로드 | PASS | S7a, S7b, S7c |
| U7 | Codex 가시성 | PASS — spawn만 보이고 토큰은 Codex 로그에서 | S6 |
| U8 | (이미 해결) | — | — |
| U9 | `turn.step` 오버헤드 | PASS(+1.9%, 잡음 범위) | S9 |

남은 U: U4 하나(Workflow, 사람 opt-in 필요).

## 4. 스키마 v2 수정 제안

1. **`agents[*]`는 첫 `turn.start`/`turn.step`에서 만들고 spawn 정보는 나중에 합친다.** 에이전트의 `turn.start`가 `agent.spawn`의 결과(agentId)보다 먼저 온다 — probe의 `seen.start`가 3건 모두 0이었다.
2. **`background`는 판정에 쓰지 않는다.** 이 빌드에서는 항상 true다. 필드는 남기되 "포그라운드/백그라운드 비교" 지표는 만들지 않는다.
3. **세션 시작 전 이벤트 버퍼가 필요하다.** `classic.SessionStart`(startup)와 `classic.InstructionsLoaded`(session_start)는 `session.start` 훅보다 먼저 온다. 버퍼링한 뒤로는 둘 다 잡혔다.
4. **마찰 카운터에 `tool.call` 관찰 훅을 넣는다(plan P1의 "tool.call 훅 없음" 철회).** 사용자 권한 거부는 `classic.PermissionDenied`(auto 모드 분류기 거부용)로 오지 않고 `tool.call` 결과 `isError`로만 보인다. 거부 = `isError`이면서 `PostToolUseFailure`가 없는 호출. 재진입 위험은 S4로 해소됐다. 결과 필드 `friction.{aborted, toolErrors, rejected, compactions}`.
5. **비용은 `cost: { usdAtStart, usdAtEnd, provenance }`로 바꾼다.** 장부 USD가 세션 누적이라 재개 run에 이전 비용이 섞인다. 모델별 USD와 보조 호출 몫은 P2 파서가 `cost-state`에서 가져오고, `auxiliary = 장부 − step 합`을 리포트에 따로 표시한다.
6. **`instructions[]`(정본 지문)를 추가한다.** `{ memoryType, loadReason, pathHash, contentHash, bytes, mtimeMs }` — 경로·본문은 저장하지 않는다. `classic.InstructionsLoaded`를 주로, `$.fs.ancestors` 스캔을 보조로 쓴다. 스킬 파일은 이름만 보이고(경로 미노출) 해시는 별도 스캔이 필요하다(미검증).

이 밖에 `delegation.codex`는 Bash 분류가 아니라 **spawn의 subagentType**으로 센다. codex-rescue는 `codex exec`가 아니라 companion 스크립트로 돌아 Bash 분류에 잡히지 않았다.

## 5. G2 남은 안건 8건에 영향을 주는 발견

| 안건 | 발견 | 영향 |
|---|---|---|
| 비용 표기 | 장부 USD는 세션 누적이고 보조 호출·압축을 포함한다. 모델별 USD는 세션이 끝난 뒤의 `cost-state`에만 있다 | "엔진 장부(API 환산), 세션 누적"으로 표기한다. 실시간 상태줄은 합계만, 모델별은 P2 리포트에서 |
| 60자 저장 | agentId·subagentType·모델만으로 에이전트 식별과 귀속이 완결됐다(설명문 미사용) | 기본은 저장하지 않는 쪽(Codex 권고)으로 기운다 |
| 배포 | 로컬 폴더 마켓플레이스 + `--scope local`은 대화상자 없이 설치되고, `/reload-plugins`가 폴더를 다시 읽었다 | 판정 8의 권고(로컬 폴더 마켓플레이스)를 실측으로 뒷받침 |
| 위임 지도 | 모든 spawn이 백그라운드라 주 턴과 에이전트 턴이 겹친다 | 지도는 시간축 겹침으로 그린다(직렬 트리 아님) |
| 서머리 | `turn.step` 합은 보조 호출을 빠뜨린다 | 서머리 카드에 "보조·압축" 칸을 둔다 |
| 보관 | `cost-state`는 세션 종료 때 쓰인다 | 백필은 종료된 세션만 대상으로 한다 |
| narrate·리포트 구조 | `$.ui.ask`가 mod 명령 안에서 동작(S18) | `/debrief setup` 온보딩을 mod 안에서 할 수 있다. 리포트 구조 판정 자체는 영향 없음 |

## 6. P1에 넘길 메모

1. 조직 관리 환경에서는 사용자가 설치한 플러그인에 `classic.*`·`skill.prompt`·`session.compact` 훅이 돌지 않는다(validate 안내). 마찰 카운터·지문은 이 경우 "측정 안 됨"으로 표시하고 0으로 쓰지 않는다.
2. 훅에서 `$`를 못 쓰는 자리(재진입 `.catch`)는 모듈 변수에 모았다가 다음 `turn.complete`에서 합친다 — 재로드 때 그 사이 값은 잃는다.
3. 상태줄 표시는 엔진이 플러그인 이름을 앞에 붙인다. 텍스트는 짧게 둔다.
4. 시험 도구: tmux 대화형 세션 + `-p` 교차 실행이면 사람 없이 P0 시나리오 대부분을 재현할 수 있다(권한 대화상자·질문 대화상자 응답은 자기 세션에 키 입력).
5. Workflow(U4)는 P1 첫 실세션에서 사람이 "use a workflow"를 줄 때 같이 검증한다.
6. probe의 tmux 지시 분류기는 호스트 별칭을 코드에 박아 두었다(버리는 코드). P1에서는 이 패턴을 프로필 데이터로 옮긴다(코어에 머신 이름 금지).
