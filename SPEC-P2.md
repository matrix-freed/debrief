# debrief P2 스펙 — 리포트 프로그램 · 백필 · 프로젝트 AAR

> 작성 Claude 리뷰 세션(2026-10-15). 구현 Codex(3묶음), 리뷰 Claude. 이 문서가 P2 구현의 정본이다.
> 근거: `P0-RESULTS.md`, `P1-RESULTS.md`, `debrief/types/index.d.ts`(스키마 v3), plan P2 절, analysis §9·§10·§11, G2 결정(2026-10-15 16:27).

## 0. 원칙(바꾸지 말 것)

- **Python 3.9+ 표준 라이브러리만.** 외부 패키지 금지. macOS·Linux·Windows 동작(`pathlib`, `os.sep` 가정 금지, 줄바꿈·인코딩은 `utf-8` 명시).
- **메타데이터만.** 아래 허용 목록(§2) 밖 키는 읽은 즉시 버린다. 프롬프트·응답·도구 입력·경로·명령 인자·메시지 본문은 어떤 산출물에도 넣지 않는다.
- **코어 중립.** 벤더·머신·팀·사람 이름, 특정 모델 패밀리 이름을 코드 분기·색상 키·문구에 넣지 않는다. 모델 이름은 데이터로만 나온다. 이름·임계값·문구 언어는 프로필(§9).
- **fail-open.** 선택 입력(Codex 로그, insights, 프로필, cards)이 없거나 깨져도 경고 한 줄 후 계속한다. 필수 입력이 없을 때만 exit≠0.
- **다른 프로젝트 파일 무변경.** 읽기 대상(transcript, `~/.codex`, `usage-data`)은 읽기만 한다. 쓰기는 `--root`(debrief 데이터 루트)와 `--out` 경로에만.
- **mod 파일 무변경.** `runs/` 아래 mod run 파일은 `compact` 외에는 읽기만 한다.
- **원자적 쓰기.** 모든 출력은 같은 폴더의 임시 파일에 쓴 뒤 `os.replace`.
- G2 결정: 비용 = "엔진 장부(API 환산), 세션 누적" · 서브에이전트 설명 저장 안 함 · narrate 자동화 없음(4카드는 `cards.json`) · 리포트 = 별도 프로그램 + mod 래퍼 · raw 30일 후 월 rollup, 백필은 종료 세션만 · 서머리에 "보조·압축" 칸 · 위임 지도 = 시간축 겹침.

## 1. 위치·실행

- 위치: **`debrief/tools/debrief_report/`**(플러그인 폴더 안). 브리프의 `tools/debrief_report/`에서 옮긴 이유: 로컬 마켓플레이스 설치는 플러그인 폴더만 `<config>/plugins/cache/<market>/debrief/<ver>/`로 복사한다(실측 `installPath`). mod 래퍼가 `$.plugin.root` 기준으로 찾으려면 플러그인 안에 있어야 한다.
- 실행: `python3 debrief/tools/debrief_report <subcommand> ...`(폴더 실행, `__main__.py`). 모듈은 같은 폴더의 패키지 `debrief_report`가 아니라 폴더 자체를 `sys.path[0]`으로 쓰는 평면 모듈(`cli.py`, `transcript.py`, `backfill.py`, `codex.py`, `insights.py`, `model.py`, `aar.py`, `render.py`, `ledger.py`, `summary.py`, `compact.py`, `export.py`, `profile.py`, `paths.py`). 파일 구성은 구현자 재량, 진입점·서브커맨드·출력은 이 스펙대로.
- 테스트: `python3 -m unittest discover -s debrief/tools/debrief_report/tests -t debrief/tools/debrief_report` 가 저장소 루트에서 통과해야 한다. 테스트는 임시 폴더만 쓴다.
- 공통 옵션: `--root <dir>`(기본: `DEBRIEF_DIR` 환경변수, 없으면 첫 `--config`의 `debrief`, 없으면 `~/.claude/debrief`). `--config <dir>`는 반복 가능(다계정: `~/.claude`, `~/.claude-alt`). 기본은 `CLAUDE_CONFIG_DIR` 또는 `~/.claude` 하나. 홈은 `HOME`, 없으면 `USERPROFILE`.
- 종료 코드: 0 성공 · 1 검증 불일치(백필 수 불일치, 대조 diff) · 2 사용법·필수 입력 오류.
- 표준출력은 사람이 읽는 요약 + 마지막 줄에 `RESULT <json>`(한 줄, 결과 경로·수치). 래퍼(§10)는 이 줄만 파싱한다.

## 2. 허용 목록

### 2.1 transcript(Claude Code `<config>/projects/<slug>/*.jsonl`, `<slug>/<sessionId>/subagents/agent-<id>.jsonl`, `agent-<id>.meta.json`)

| 줄 | 읽는 키 | 용도 |
|---|---|---|
| 모든 줄 | `type`, `timestamp`, `sessionId`, `isSidechain`, `agentId`, `entrypoint` | 시간·루프·표면(`entrypoint`는 짧은 열거값만, 32자 넘거나 공백 있으면 버림) |
| 모든 줄 | `cwd` | **즉시 slug로 바꾸고 원문 폐기**(§3.4 귀속). 원문 경로는 메모리에도 오래 두지 않는다 |
| `assistant` | `requestId`, `message.id`, `message.model`, `message.usage`(4카운터만: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `message.stop_reason`, `effort`, `message.content[].type=="tool_use"` 의 `name`과 `id`(id는 중복 제거에만, 저장 금지), `isAbortedMidStream`, `isApiErrorMessage` | 사용량·도구·마찰 |
| `user` | `message.content[].type=="tool_result"` 의 `is_error`(불리언)만, `toolDenialKind` 존재 여부(불리언으로만) | 마찰 |
| `system` | `subtype`(예 `compact_boundary`) | 압축 수 |
| `cost-state` | `startTime`, `totalCostUSD`, `modelUsage[model]{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}` | 엔진 장부 |
| `agent-<id>.meta.json` | `agentType`, `spawnDepth` | 서브에이전트 유형(`description`·`toolUseId`·`requestShape` 금지) |

그 밖의 줄 종류(`attachment`, `last-prompt`, `ai-title`, `api-request*`, `file-history-*`, `queue-operation`, `bridge-session` 등)는 `type`만 보고 건너뛴다.

### 2.2 Codex(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `--codex-dir`로 변경)

| 줄 | 읽는 키 |
|---|---|
| `session_meta` | `timestamp`, `payload.cwd`(즉시 slug로, 원문 폐기), `payload.originator`, `payload.source`, `payload.cli_version` |
| `turn_context` | `timestamp`, `payload.model`, `payload.effort` |
| `token_usage_record` | `timestamp`, `payload.response_id`(중복 제거용, 출력 금지), `payload.usage{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` |
| `event_msg` `task_started`/`task_complete` | `timestamp`만 |

주의: Codex `input_tokens`는 `cached_input_tokens`를 **포함**한다. 처리 토큰 = `input − cached + output`.

### 2.3 insights(`<config>/usage-data/session-meta/*.json`, `facets/*.json`)

- session-meta: `session_id`, `start_time`, `duration_minutes`, `user_message_count`, `assistant_message_count`, `tool_errors`, `tool_error_categories`(키·수), `user_interruptions`, `git_commits`, `git_pushes`, `lines_added`, `lines_removed`, `files_modified`, `uses_task_agent`.
- facets: `session_id`, `outcome`, `session_type`, `claude_helpfulness`, `friction_counts`(키·수), `user_satisfaction_counts`(키·수).
- **금지**: `first_prompt`, `underlying_goal`, `brief_summary`, `friction_detail`, `primary_success`, `goal_categories`, `project_path`, `user_message_timestamps`, `user_response_times`, `message_hours`, `languages`. 테스트 픽스처에 이 필드를 표식 문자열로 넣고 어떤 출력에도 없음을 확인한다.
- 열거값 문자열(outcome 등)과 카운터 키는 64자 이하·제어문자 없음만 통과.

### 2.4 HTML 내보내기 허용 목록(§6.3) — 리포트 데이터 JSON의 키 경로 전체를 코드에 상수로 둔다.

## 3. backfill

`backfill [--config DIR]... [--root DIR] [--days 30] [--idle-minutes 60] [--project SLUG]... [--exclude-session ID]... [--now ISO]`

1. 발견: 각 config의 `projects/*/` 아래 최상위 `*.jsonl` = 세션 1개(파일 이름 = sessionId). `--project`가 있으면 그 slug만. 마지막 수정 시각이 `now − days` 이전이면 범위 밖(세지 않음).
2. **종료 판정**(하나라도 참이면 종료): (a) 파일 순서상 마지막 `assistant` 줄 뒤에 `cost-state` 줄이 있다, (b) 파일 mtime이 `now − idle-minutes`보다 오래됐다. 아니면 `skip: open`. `--exclude-session`은 `skip: excluded`(자기 관찰 제외 규칙, analysis §9).
3. 스트리밍: 줄 단위로 읽는다(파일 전체 로드 금지). 깨진 줄은 세고 건너뛴다(`badLines`). 4 MiB 이상 파일도 같은 경로 — 테스트는 임시로 5 MiB 파일을 만들어 확인.
4. 요청 중복 제거: 키 `(requestId, message.id)`. 같은 키가 여러 줄이면 **마지막 줄의 usage**를 쓴다(스트리밍 청크, analysis §9 데이터 품질). 키가 둘 다 없으면 줄마다 별개 요청. usage가 없는 요청은 `nullUsageSteps`.
5. 루프: 메인 파일의 줄 = `main`(단 `isSidechain: true`이고 `agentId`가 있으면 그 agentId 루프). `subagents/agent-<id>.jsonl` = 루프 `<id>`. 서브에이전트 파일이 메인 파일에도 중복으로 실린 경우를 대비해 **세션 전체에서** 요청 키로 중복 제거(먼저 본 루프에 귀속, usage는 마지막 줄).
6. 출력: 세션당 1파일 `<root>/_backfill/<slug>/<sessionId>/backfill.json`, 스키마 v3 + `source: "backfill"`, `runId: "backfill"`, `recorder: "debrief-report/<ver>"`, `engine: "transcript"`. 필드 채우기:
   - `run.startedAt/endedAt` = 첫·마지막 `timestamp`(ms epoch), `endReason` = `"closed"` 또는 `"idle"`, `surface` = 처음 본 `entrypoint` 또는 null, `isInteractive` = entrypoint가 `cli`면 true 아니면 false, `coverage: "complete"`(깨진 줄이 있으면 `"partial"`).
   - `usage[loop][model]`, `effort[model][effort]`(effort 없으면 `"none"`, 요청 키 단위로 1회), `requestedToolCalls[loop][name]`(tool_use 블록 `id`로 세션 전체 중복 제거).
   - 에이전트 시간: 그 루프의 줄(종류 무관) 중 `timestamp` 최소·최대. 세션 시간: 모든 파일의 `timestamp` 최소·최대(`cost-state`에는 timestamp가 없다).
   - `steps[]`: 요청마다 `{loop, turnId:"", index, model, effort?, stopReason, usage|null, at}`. 링 상한 2000(프로필 `limits.stepRing`), 넘치면 오래된 것부터 버리고 `run.dropped.steps`.
   - `turns: []`, `openTurns: {}`(transcript로는 턴 경계를 재구성하지 않는다).
   - `agents[id]`: `subagentType`(meta의 agentType), `model`(첫 요청 모델), `resumed:false`, `spawnAttempts:1`, `turns:0`, `firstSeenAt`, `durationMs`(마지막 − 첫 timestamp), `seen{start:0, steps:n, complete:0, spawn:0}`.
   - `cost`: `cost-state` 줄을 `startTime`으로 묶어 묶음마다 마지막 `totalCostUSD`를 취하고 합한다 → `usdAtStart: 0`, `usdAtEnd: 합`, `provenance: "engine-ledger"`. 없으면 `provenance: "unknown"`.
   - **새 선택 필드** `ledger: { models: { [model]: {in, out, cacheRead, cacheWrite, usd} }, groups: n }` — 위와 같은 묶음 규칙으로 모델별 장부 합. mod 파일에는 없다(없으면 리포트가 "측정 안 됨").
   - `friction`: `aborted` = `isAbortedMidStream` 요청 수, `toolErrors` = `is_error: true` 결과 수, `rejected` = `toolDenialKind` 있는 user 줄 수, `compactions` = `system.subtype == "compact_boundary"` 수.
   - **새 선택 필드** `attribution: { [slug]: { steps, processed, firstAt, lastAt } }` — 요청 줄의 `cwd`를 §3.4 규칙으로 slug화한 키별 합.
   - 나머지 v3 필드는 빈 값(`spawnDenied:0`, `workflowRuns:[]`, `serverToolUses:{}`, `toolCalls{main,agent,isError,denied:0,reentry:{}}`(main·agent는 tool_use 수, isError는 toolErrors), `classic{seen:false,...}`, `skills:{}`, `commands:{}`, `messaging{sent:{},received:{}}`, `delegation{external:{},directives:{}}`, `tags:[]`, `instructions:[]`, `context:{}`, `profileSource:"default"`, `writes{ok:1,failed:0}`).
7. 이미 같은 백필 파일이 있으면 덮어쓴다(재실행 멱등). mod 파일 `runs/` 는 열지 않는다.
8. 출력·검증: `found`(범위 안 세션 수), `closed`, `written`, `skipped[{session순번, reason}]`(stdout에는 sessionId 앞 8자 허용 — 로컬 콘솔, HTML 아님). `written + len(skipped) != found` 또는 종료 세션인데 파일이 없으면 exit 1.

### 3.4 slug 규칙

Claude Code의 transcript 폴더 이름 규칙: 영숫자가 아닌 문자를 모두 `-`로(`re.sub(r'[^A-Za-z0-9]', '-', cwd)`). 백필의 세션 slug는 폴더 이름 그대로 쓴다. `cwd` → slug 변환에만 이 규칙을 쓴다. (참고: mod `paths.ts slugOf`는 `/ \ :`만 바꾼다 — 점·밑줄이 있는 경로에서 어긋난다. P2 묶음 3에서 같은 규칙으로 맞춘다.)

## 4. 어댑터

### 4.1 codex

`codex [--codex-dir DIR] --project SLUG [--from ISO --to ISO] [--root DIR]` — 결과를 stdout JSON으로(파일 쓰지 않음). 라이브러리 함수 `codex_usage(codex_dir, slugs, t0, t1, sessions)`를 aar가 같이 쓴다.

- rollout 1개 = 외부 실행 1건: `{startedAt, endedAt, model, effort?, originator, requests, tokens{input, cached, output, reasoning, processed}}`. 요청 중복 제거는 `response_id`.
- 프로젝트 귀속: `session_meta.cwd`의 slug가 프로젝트 slug와 같거나 그 slug + `-`로 시작(하위 폴더).
- 세션 짝짓기: `originator`가 Claude 쪽 호출을 뜻하는 값(프로필 `externalOriginators`, 기본 `["Claude Code"]` — 중립 기본값 하나만 코드에 둔다)이면 순서대로 짝짓는다(P2 묶음 2 리뷰에서 변경 — 실데이터에서 '시작이 가장 가까운 세션' 규칙이 위임하지 않은 세션에 붙였다): (1) 프로필 `externalAgentTypes`에 든 서브에이전트의 창(첫 요청~끝, 앞뒤 60초) 안에 실행 시작이 있는 세션, (2) 실행 시작을 시간 범위 `[startedAt, endedAt]`에 품은 세션 중 가장 늦게 시작한 것, (3) 끝난 지 5분 이내인 세션 중 끝이 가장 가까운 것. 못 짝지으면 `matchedSession: null`.
- Claude 합계와 절대 섞지 않는다. 폴더가 없으면 빈 결과, exit 0.

### 4.2 insights

`insights [--config DIR]... --session ID...` 또는 라이브러리 `insights_for(config_dirs, session_ids)` — §2.3 허용 키만 담은 `{sessionId: {meta:{...}, facets:{...}}}`. 없으면 빈 객체.

## 5. 데이터 모델(aar·summary 공통 적재)

`load_project(root, slugs, t0, t1)`:
- 세션 단위로 모은다. mod run 파일(`runs/<slug>/<sid>/*.json`)이 있는 세션은 **mod 우선**, 없으면 `_backfill/<slug>/<sid>/backfill.json`, 둘 다 없으면 rollup(§8)의 세션 요약.
- 세션 합계는 run들의 합. 비용은 run마다 `usdAtEnd − usdAtStart`(음수·누락은 0, `estimated` 표시) 합.
- 처리 토큰(processed) = `in + cacheWrite + out`(캐시 읽기 제외 입력 + 출력). 화면의 모든 "처리 토큰"이 이 정의. 캐시 읽기는 별도 열로만.
- `overlap(root)`: mod와 백필이 둘 다 있는 세션마다 루프별·모델별 `{in,out,cacheRead,cacheWrite,steps−nullUsageSteps}`를 비교. 서브커맨드 `overlap [--root] [--project]...` — 일치 세션 수·diff 출력, diff 있으면 exit 1, 비교 가능한 세션이 `--min`(기본 3) 미만이면 exit 1.

## 6. aar

`aar --project SLUG[,SLUG...] [--title TEXT] [--from ISO --to ISO] [--cards cards.json] [--profile profile.json] [--codex-dir DIR] [--config DIR]... [--root DIR] [--tz Asia/Seoul|+09:00] --out FILE.html`

### 6.1 데이터 → 화면 섹션(순서)

1. 헤더: 제목(기본 "프로젝트 AAR"; `--title` 또는 cards.json `title`), 기간(첫 세션 시작 ~ 마지막 세션 끝, 프로젝트 전체), 세션 수, 기록 출처 배지(mod n · backfill n · rollup n), 테마 전환 버튼.
2. 히어로 + 타일: 비용이 하나라도 있으면 히어로 = **"엔진 장부(API 환산) $X.XX"**, 부제 "세션 누적, run별 차의 합"; 없으면 히어로 = 처리 토큰. 타일: 처리 토큰, 캐시 읽기, 요청 수, 세션 수, 서브에이전트 수, 작업 시간(세션 벽시계 합, 겹침 포함 표기), Codex 외부 처리 토큰(있을 때).
3. **4카드**(계획/실제/차이/개선) — `cards.json`에서만. 없으면 "작성되지 않음 — cards.json으로 넣는다" 안내 카드. 근거 참조(`evidence[]`)를 카드 아래 작은 글씨로.
4. **개선 항목** — 항목마다 제목, 레버, 대상, 지표, 장부 ID·상태, 재발 후보, **적용 프롬프트(`<pre>`) + 복사 버튼**(`navigator.clipboard.writeText`, 실패 시 텍스트 선택).
5. 모델별 처리 토큰(가로 막대) + 모델×루프 표(main / agent 합 / agent 유형별): 입력·출력·캐시 읽기·캐시 쓰기·요청·처리 토큰. effort 분포(요청 수).
6. 비용·장부 표: 세션별 엔진 장부 USD, **"보조·압축"** 칸 = 장부 모델별 처리 토큰 − 요청 합 처리 토큰(백필 세션만, `estimated` 배지, basis "cost-state 장부 − transcript 요청 합"; mod 세션은 "측정 안 됨"). 음수면 0으로 두고 "장부 지연" 표시(장부는 중간 스냅샷이라 마지막 요청이 빠질 수 있음, P0 S10). Codex 외부 사용량은 **별도 표**(실행 수, 모델, 처리 토큰, 시간, 짝지은 세션 순번) — Claude 합계 행에 더하지 않는다.
7. **세션 목록과 관계**: 순번(S1…, 시작순), 시작·끝(시:분), 길이, 출처, 표면, 주 모델, 처리 토큰, 서브에이전트 수, 부모(`parentSessionId`가 있으면 그 순번, 아니면 "—"), Codex 짝 수.
8. **위임 지도(시간축 겹침)**: x = 프로젝트 기간 시간축(눈금 간격은 기간 길이로 자동: 2시간 미만 10분, 하루 미만 1시간, 그 이상 1일 — 값과 눈금은 데이터 필드 `axis{t0,t1,tickMs,bucketMs}`), 레인 = 세션 메인 루프, 그 아래 서브에이전트(첫~마지막 요청), Codex 실행(시작~끝, 외부 색). 직렬 트리가 아니라 같은 시각의 막대가 위아래로 겹쳐 보이게.
9. **대표 세션 타임라인**: 처리 토큰 최대 세션. 레인 = main + 에이전트, 요청마다 점/짧은 막대(모델 색), 태그(`tags[]`)는 위쪽 띠(시작 = 태그 시각, 끝 = 다음 태그 또는 세션 끝).
10. 마찰 카운터: 세션별 aborted·toolErrors·rejected·compactions(null은 "측정 안 됨"), insights가 있으면 friction_counts·outcome 보조 열("insights 보조" 라벨).
11. 정본 지문: 세션 순서대로 `instructions[]`의 `pathHash`별 `contentHash`가 바뀐 횟수, 바뀐 세션 순번. 해시는 앞 8자만. 데이터 없으면 "측정 안 됨(백필은 지문 없음)".
12. **메타데이터 가설 카드**(§6.4).
13. **선언 대 실제**(§6.5, 프로필 있을 때만).
14. 도구 상위 10(요청 기준 tool_use 이름·수), 기록 범위 문단(출처·제외 규칙·처리 토큰 정의·추정값 기준).

### 6.2 HTML 형식

- 파일 1개, 외부 리소스 0(폰트·스크립트·CDN 금지), 한국어 기본(프로필 `language: en`이면 영어 문구 표). 이모지·화살표 글자(→ ← ↑ ↓ ⇒ 등)·장식 기호 금지.
- `<script type="application/json" id="aar-data">` 블록 하나 + 인라인 렌더 스크립트가 화면 전체를 그린다(손으로 만든 실데이터 예시 AAR 방식). JSON 안의 `<`는 `\u003c`로 이스케이프.
- 스타일: 예시의 CSS 토큰 체계(`--page --surface --raised --ink --ink-2 --muted --grid --axis --ring --accent(보라) --gold --good --bad`, 라이트 기본 + `prefers-color-scheme: dark` + `[data-theme]` 수동 전환). **모델 색은 이름 키가 아니라 팔레트 슬롯 `--m1..--m6`**을 처리 토큰 순으로 배정(코어 중립). 외부(Codex) 색 `--ext`. 보라·금색은 강조에만 절제.
- 추정값은 `{value, estimated:true, basis}` 형태로 데이터에 두고 `추정` 배지 + title 속성에 basis.
- 폭 360px에서 가로 스크롤 없이(SVG 영역만 `.scroll` 안에서 스크롤 허용).

### 6.3 내보내기 허용 목록(필수)

- `export.py`에 리포트 데이터의 **허용 키 경로 집합**을 상수로 둔다(배열 원소는 `[]`). `build_report_data()`의 결과를 `export()`가 허용 경로만 복사해 새로 만든다 — 허용 목록 밖 키는 조용히 떨어지지 않고 **개발 중 예외**(테스트에서 잡힘), 실행 시엔 경고 후 제거.
- 값 검사: 모든 문자열 값에 대해 경로 패턴(`/Users/`, `/home/`, `C:\`, `~/`), UUID 패턴(8-4-4-4-12), 64자 이상 16진수가 없어야 한다. 예외는 cards.json 본문·적용 프롬프트(사람이 쓴 텍스트, 작성자 책임 — 그래도 UUID·홈 경로 패턴은 검사해 경고).
- 세션은 순번(`S1`…), 에이전트는 `S1-A1`…, Codex 실행은 `X1`…. sessionId·agentId·runId·response_id·slug 원문 금지. 프로젝트 표시는 `--title` 또는 cards.json `title`(없으면 "프로젝트").

### 6.4 메타데이터 가설 카드(중립·보수 기본값)

프로필 `hypotheses` 임계값(기본은 `thresholdStyle: conservative`):

| id | 조건(conservative / standard) | 문구(가설, 중립) |
|---|---|---|
| `long-no-subagent` | 세션 벽시계 ≥ 120분 / 60분 이고 서브에이전트 0 | "긴 세션에서 서브에이전트를 쓰지 않았다 — 분담할 수 있는 작업이 있었는지 확인해 볼 수 있다" |
| `single-top-model` | 요청 ≥ 50 / 20이고 `topModels` 패턴(프로필, 기본 빈 목록)에 맞는 요청 비율 ≥ 0.98 / 0.9. 패턴이 비면 "한 모델이 요청의 98% 이상"으로 판정·문구 | "요청이 거의 한 모델에 몰렸다 — 단순 작업을 다른 모델로 나눌 여지가 있는지 볼 수 있다" |
| `tool-error-rate` | 도구 호출 ≥ 20 / 10이고 toolErrors/도구 호출 > 0.10 / 0.08 | "도구 오류 비율이 높다 — 반복되는 오류 유형이 있는지 확인해 볼 수 있다" |

카드마다 "가설" 배지, 근거 수치, 해당 세션 순번. 해당 없음이면 "해당 없음" 한 줄.

### 6.5 선언 대 실제(프로필 있을 때만)

프로필의 `mainLane`·`lanes{subagentType: lane}`·`externalAgentTypes`와 실제 비교: 레인별 선언 여부·실제 spawn 수·처리 토큰, 선언했는데 0회인 레인, 선언 안 했는데 쓴 유형(`미선언`). 프로필이 없으면 섹션 자체를 그리지 않는다.

### 6.6 cards.json

```json
{ "version": 1, "title": "표시 제목",
  "cards": [ {"k":"plan","title":"계획","body":"...","evidence":["P1-RESULTS.md 1절"]},
             {"k":"actual",...}, {"k":"gap",...}, {"k":"improve",...} ],
  "improvements": [ {"id":"선택(기존 장부 ID)","title":"...","lever":"template|skill|hook|setting|statusline|instruction",
                     "target":"...","metric":"...","what":"...","where":"...","how":"...","verify":"...","evidence":["..."]} ] }
```

`k` 순서는 plan·actual·gap·improve 고정. body는 문단(빈 줄로 구분), HTML 이스케이프 필수.

### 6.7 적용 프롬프트 틀(코어, 언어별 1벌)

```
[debrief 개선 적용 — 장부 {id}]
이 프롬프트는 AAR 맥락 없이 실행된다. 아래만 근거로 작업한다.
무엇을: {what}
어디에: {where} (레버: {lever}, 대상: {target})
어떻게: {how}
근거: {evidence 목록}
검증: {verify} — 측정 지표: {metric}
끝나면: debrief 장부 항목 {id}의 상태를 applied로 바꾼다(`/debrief ledger set {id} applied` 또는 리포트 프로그램 `ledger set {id} applied`). 검증까지 확인했으면 verified.
범위 밖 파일은 바꾸지 않는다. 판단이 필요한 지점이 있으면 바꾸기 전에 사용자에게 확인한다.
```

## 7. ledger · summary

### 7.1 ledger

- 파일: `<root>/ledger.json`, `schema/ledger.schema.json`(아래 확장 반영).
- 스키마 확장(P2): 항목에 선택 필드 `title`(필수로 승격하지 않음 — 기존 호환), `project`(표시 제목), `recurrenceOf`(ID 배열). `types/index.d.ts DebriefLedgerItem`도 같이.
- `aar`가 cards.json의 improvements를 등록: `id`가 있으면 그 항목 갱신(상태 유지), 없으면 새 ID = `i-<YYYYMMDD>-<제목 정규화 sha1 앞 6자>`(같은 제목 재실행 시 같은 ID — 멱등). 새 항목 상태 `proposed`, `applyPrompt` = §6.7 결과, `evidence`, `createdAt/updatedAt`(ISO).
- 재발 후보: 정규화 제목(소문자, 공백 압축, 구두점 제거) `difflib.SequenceMatcher` 비율 ≥ 0.6인 **다른 ID** 기존 항목을 `recurrenceOf`에 넣고 AAR 개선 카드에 "재발 후보: {id}({상태})".
- `ledger list [--status S]`, `ledger set <id> <proposed|applied|verified|dropped>`(없는 ID exit 2, `updatedAt` 갱신). 원자적 쓰기.
- `aar --no-ledger`면 등록 생략(테스트·미리보기).

### 7.2 summary

`summary --session ID [--root] [--threshold-share 0.10] [--threshold-min 10] --out FILE.html`
- 세션의 run 파일(mod 우선, 백필)에서 `attribution`(백필) 또는 run의 `project.slug`(mod: run별 1개)로 프로젝트 키별 처리 토큰·시간·모델을 모은다.
- 키가 임계값(처리 토큰 비율 ≥ 10% 또는 시간 ≥ 10분) 이상인 것이 2개 이상이면 프로젝트별 카드 페이지, 아니면 "단일 프로젝트 세션" 한 장. 임계 미만 합은 "미분류" 카드(합계가 맞도록).
- 카드: 작업 시간(겹침 포함 표기), 모델별 처리 토큰, Codex 외부(시간·토큰, 있으면). 프로젝트 표시 이름은 프로필 `projects{slug: 표시이름}` 또는 "프로젝트 1, 2…" — slug 원문 금지.
- 한계(문서화): 도구 입력 경로 기반 귀속은 허용 목록 밖이라 하지 않는다. `cwd` 기반만.

## 8. compact

`compact [--root] [--days 30] [--now ISO] [--dry-run]` · `compact --delete-archives-before YYYY-MM --yes`

- 대상: `runs/<slug>/<sid>/*.json`과 `_backfill/<slug>/<sid>/backfill.json` 중 `run.endedAt`이 있고 `now − days` 이전인 것. 열린 run(`endedAt` 없음)은 `lastCheckpointAt`이 `days × 2` 이전일 때만(버려진 run).
- 월(endedAt 기준, UTC) 단위로 `runs/<slug>/rollup-YYYY-MM.json`에 접는다: `{version:1, slug, month, sessions:{sid:{source, runIds[], startedAt, endedAt, usage, effort, cost, ledger?, agents(요약: subagentType·model·firstSeenAt·durationMs), friction, tags, instructions, requestedToolCalls, attribution?}}}` — **steps·turns 링 제외**. 이미 있으면 병합(runId 기준 중복 방지 — 멱등).
- raw 파일은 `archive/YYYY-MM.tar.gz`에 루트 기준 상대 경로로 추가(기존 아카이브가 있으면 새 tar.gz로 다시 써서 교체, 원자적). 아카이브에 들어간 것을 다시 열어 바이트 비교한 뒤에만 raw를 지운다(이동). 빈 세션 폴더 제거.
- 아카이브 삭제는 `--delete-archives-before ... --yes`에서만. `--yes` 없으면 대상 목록만 출력, exit 2.
- `--dry-run`은 계획만 출력, 쓰기 0.

## 9. 프로필(선택, `--profile` 또는 `<root>/profile.json`)

P1 프로필 v1에 P2 선택 필드 추가: `hypotheses{...임계값 덮어쓰기}`, `topModels[]`(정규식), `externalOriginators[]`, `projects{slug: 표시이름}`. 없으면 전부 기본값. 예시 프로필(`schema/profile.example.json`)은 중립 값만.

## 10. mod 래퍼(묶음 3)

- `/debrief aar [--from ..] [--to ..] [--cards PATH]`, `/debrief backfill [--days N]`, `/debrief compact [--dry-run]`, `/debrief ledger [list|set ID STATUS]`.
- `$.process.run([python, <plugin.root>/tools/debrief_report, sub, ...고정 argv], { cwd: <root>, timeoutMs })` — python은 `python3` 먼저, 실패하면 Windows용 `py -3`, 둘 다 시작 실패면 "python3가 필요합니다 — 설치 안내: https://www.python.org/downloads/" 한 줄(fail-open, 예외 던지지 않음). 프로그램 폴더 덮어쓰기는 `DEBRIEF_REPORT_DIR`.
- 인자 전달: 사용자가 쓴 인자는 허용 플래그(`--from --to --cards --days --dry-run` 등)만 통과, 나머지는 거부 메시지. 셸 미사용(argv).
- aar 래퍼가 고정으로 넣는 것: `--project <현재 세션 slug>`, `--root <root>`, `--config <CLAUDE_CONFIG_DIR 또는 home/.claude>`, `--exclude-session <현재 세션>`(backfill), `--out <root>/aar/<slug>/<YYYY-MM-DD-HHmm>.html`.
- 타임아웃: aar·backfill 600 s, compact 300 s, ledger 30 s. 종료 코드 ≠ 0이면 stderr 앞 20줄과 코드 표시. `isStdoutTruncated`면 "출력 잘림" 표시. 성공 시 `RESULT` 줄의 경로를 항상 보여 준다. `open`은 하지 않는다(선택 — 이번엔 미구현).
- 테스트: 기존 테스트 키트로 `$.process.run` 가짜 응답 3종(성공·exit 1·시작 실패)과 argv 고정 확인.
- 같은 묶음에서 `paths.ts slugOf`를 §3.4 규칙으로 맞춘다(기존 테스트 갱신).

## 11. 테스트 픽스처(합성, 리뷰 세션 작성 — `tests/fixtures/`)

| 픽스처 | 내용 | 손 계산 기대값 |
|---|---|---|
| F1 `cfg-a/projects/-tmp-proj-alpha/aaaaaaaa-0000-4000-8000-000000000001.jsonl` | 메인만, 모델 2개, 같은 요청 키 3청크(마지막이 최종), usage 없는 요청 1, effort 2종, tool_use 3·오류 1, cost-state 2묶음(재개), 끝에 cost-state → 종료 | `expected.json` |
| F2 `cfg-a/projects/-tmp-proj-alpha/aaaaaaaa-0000-4000-8000-000000000002.jsonl` + `…0002/subagents/agent-a1.jsonl` + `.meta.json` | 메인 + 서브에이전트 1(모델 다름), 메인 파일에 사이드체인 중복 1줄, compact_boundary 1, 금지 키 표식(`description`, `cwd` 원문) | `expected.json` |
| F3 `cfg-b/projects/-tmp-proj-alpha/aaaaaaaa-0000-4000-8000-000000000003.jsonl` | 다른 config(다계정), 깨진 줄 1, cost-state 없음(→ mtime으로 종료 판정, 테스트가 mtime 설정), cwd가 다른 프로젝트인 요청 포함(귀속 2키) | `expected.json` |
| F4 열린 세션 `…0004.jsonl` | 마지막 줄이 assistant, mtime 최신 | `skip: open` |
| `codex/2026/10/15/rollout-*.jsonl` 2개 | 하나는 originator 일치·시간 안(짝), 하나는 다른 cwd | `expected.json` |
| `usage-data/session-meta`, `facets` | 금지 필드에 표식 `FORBIDDEN-MARKER-…` | 출력 0건 |
| `mod-runs/` | F1 세션의 mod run 파일(v3) — 겹침 검사 일치용, 그리고 일부러 1 다른 값 하나(불일치 검출용 별도 사본) | overlap 일치 1 / diff 1 |
| `cards.json`, `profile.json` | 4카드·개선 2건, 레인 선언 | HTML 기대 문자열 |

모든 표식 문자열(`FORBIDDEN-MARKER-`로 시작)은 어떤 출력 파일(run JSON, rollup, HTML, ledger, stdout)에도 없어야 한다 — 공통 테스트.

## 12. 묶음 나누기(위임 단위)

1. **묶음 1**: §1 골격(cli, paths, 공통 옵션, RESULT 줄) + §2.1–2.3 + §3 backfill + §4 어댑터 + §5 적재·overlap + 해당 테스트. 픽스처는 리뷰 세션이 만든 것을 쓰고 기대값을 바꾸지 않는다(어긋나면 보고).
2. **묶음 2**: §6 aar(HTML·export 허용 목록·가설·선언 대 실제·cards·적용 프롬프트) + §7 ledger·summary + 스키마·타입 확장 + 테스트.
3. **묶음 3**: §8 compact + §10 mod 래퍼(TypeScript, 기존 register.ts 구조 유지) + slugOf 정렬 + 테스트.
