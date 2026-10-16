# debrief

A Claude Code mod that records **session metadata only** (models, tokens, the engine cost
ledger, time, subagents, friction counts) and turns it into a project after-action review
(AAR): plan, actual, gap, improvement, with charts and copy-paste improvement prompts.

[한국어는 아래에 있습니다.](#한국어)

---

## What it records, and what it never records

Recorded, per process run, as one JSON file on your own machine:

- tokens per loop (main or each subagent) and per model: input, output, cache read, cache write, requests
- effort level counts, request timestamps (a bounded ring), turn timing
- the engine cost ledger snapshot (session cumulative, API-equivalent USD)
- subagents: declared type, model, first seen, duration, spawn attempts
- friction counters: aborted requests, tool errors, rejected tools, compactions
- tool and skill **names** with counts; session message counts by origin kind
- instruction file fingerprints as **hashes only** (path hash, content hash, size)
- phase tags you type yourself with `/debrief tag <label>` (the only text kept)

Never recorded: prompts, responses, tool inputs (including file paths and commands), command
arguments, skill bodies, subagent descriptions or prompts, session message bodies. Reports
show sessions as `S1`, `S2`, agents as `S1-A1`, external runs as `X1`; session IDs, paths and
project folder names never reach the HTML. Every report value passes an export allowlist
(key paths) and a value check (home paths, UUIDs, request IDs) before it is written.

## Structure

| Part | Where | Role |
|---|---|---|
| Core recorder (mod) | `debrief/hooks/` | Writes `<root>/runs/<project>/<session>/<run>.json`. No vendor, machine, team or person names in code |
| Report program | `debrief/tools/debrief_report/` | Python 3 standard library only. Backfill, AAR, summary, compaction, ledger |
| Adapters (optional) | same program | External agent logs (Codex rollouts) and `/insights` data; silently skipped when absent |
| Profile (optional) | `<root>/profile.json` | Language, lanes you declare, thresholds, external agent types. Built by `/debrief setup`. Never committed. Without one, reports and the setup dialogue follow the terminal locale (`LC_ALL`, then `LANG`: `ko_*` is Korean, anything else English) |

`<root>` is `DEBRIEF_DIR`, else `<CLAUDE_CONFIG_DIR or ~/.claude>/debrief`.

## Requirements

- Claude Code 2.1.288 or later (mods are early access)
- macOS, Windows or Linux
- Python 3 for the report commands (no packages to install). Without it the recorder still works and the report commands print an install hint.

## Install

```
/plugin marketplace add matrix-freed/debrief
/plugin install debrief@debrief
```

On Claude Code 2.1.275 or later this also works in one step:

```
/plugin install debrief --marketplace matrix-freed/debrief
```

### Let Claude install it

Paste this into a Claude Code session:

```
Install the debrief plugin for me: add the marketplace matrix-freed/debrief, install
debrief@debrief, then tell me to restart the session. After the restart, run /debrief setup
and walk me through the questions. Do not change any other settings.
```

## Commands

| Command | What it does |
|---|---|
| `/debrief` | This session in numbers (tokens by model and loop, cost, time, agents) |
| `/debrief tag <label>` | Marks a phase; the AAR timeline draws a band from here to the next tag |
| `/debrief setup` | Builds your profile (language, lanes, thresholds) |
| `/debrief aar [--from ISO] [--to ISO] [--cards PATH]` | Project AAR HTML for the current project, written under `<root>/aar/` |
| `/debrief backfill [--days N]` | Imports closed past sessions from transcripts (metadata only) |
| `/debrief compact [--dry-run]` | Folds run files older than 30 days into monthly rollups and archives the raw files |
| `/debrief ledger [list [--status S] \| set ID STATUS]` | Improvement ledger: proposed, applied, verified, dropped |

The plan, actual, gap and improvement cards are written by people (or a session you ask) in a
small `cards.json`; debrief does not generate judgement text. Improvements get ledger IDs and a
self-contained apply prompt with a copy button.

## Running the report program directly

```
python3 debrief/tools/debrief_report backfill --config ~/.claude --root <root> --days 30
python3 debrief/tools/debrief_report aar --project <project folder name> --cards cards.json \
  --root <root> --tz +09:00 --out aar.html
python3 debrief/tools/debrief_report summary --session <session id> --root <root> --out summary.html
python3 debrief/tools/debrief_report compact --root <root> --dry-run
python3 debrief/tools/debrief_report ledger --root <root> list
```

On Windows use `py -3` instead of `python3`. Every command prints a final `RESULT {...}` line.

## Cost label

Cost is shown as **"engine ledger (API equivalent), session cumulative"**: the engine's own
running total, summed as per-run differences. On a subscription plan it is an API-equivalent
figure, not a bill. Sessions without a ledger count as zero and are flagged as estimated.
Processed tokens are input + cache write + output; cache reads are shown separately.

## Privacy and what this is not

- Records stay on your machine. Nothing is uploaded; there is no server.
- There is no per-person ranking or comparison. The AAR is about a project's way of working
  (where time and tokens went, what to change next), and its hypotheses are phrased as
  questions, not verdicts.
- Sharing is opt-in: the profile has `shareConsent: false` by default, and reports only
  contain what the export allowlist lets through.

## Status

P0 (API probe), P1 (recorder) and P2 (report program, backfill, project AAR) are done; see
`P0-RESULTS.md`, `P1-RESULTS.md`, `P2-RESULTS.md`. Known gaps from the first real AAR:

- sessions recorded before the mod was enabled have no cost ledger (counted as zero, flagged)
- automated one-shot SDK sessions are folded into one row by a simple rule (entrypoint and length)
- child sessions started for experiments carry no parent marker unless the parent sets `DEBRIEF_PARENT_SESSION`
- the `--from/--to` window selects sessions but does not clip inside a session
- open-session detection for backfill uses file idle time

## License

MIT. See `LICENSE`.

---

## 한국어

# debrief

Claude Code mod다. **세션 메타데이터만**(모델, 토큰, 엔진 비용 장부, 시간, 서브에이전트, 마찰
횟수) 기록하고, 이를 프로젝트 AAR(사후 검토: 계획, 실제, 차이, 개선)로 만든다. AAR에는 도식과
복사해 쓰는 개선 프롬프트가 들어간다.

## 기록하는 것과 절대 기록하지 않는 것

프로세스 실행 단위로, 본인 PC에 JSON 파일 하나로 남긴다.

- 루프(메인 또는 서브에이전트별)·모델별 토큰: 입력, 출력, 캐시 읽기, 캐시 쓰기, 요청 수
- effort 단계별 횟수, 요청 시각(크기 제한 링 버퍼), 턴 시간
- 엔진 비용 장부 스냅샷(세션 누적, API 환산 USD)
- 서브에이전트: 선언 유형, 모델, 처음 본 시각, 지속 시간, spawn 시도 수
- 마찰 카운터: 중단된 요청, 도구 오류, 거부된 도구, 압축
- 도구·스킬 **이름**과 횟수, 세션 간 메시지의 출처 종류별 횟수
- 지침 파일 지문(**해시만**: 경로 해시, 내용 해시, 크기)
- `/debrief tag <라벨>`로 직접 입력한 페이즈 라벨(유일하게 남기는 텍스트)

절대 기록하지 않는 것: 프롬프트, 응답, 도구 입력(파일 경로와 명령 포함), 명령 인자, 스킬 본문,
서브에이전트 설명·프롬프트, 세션 간 메시지 본문. 리포트에서 세션은 `S1`, `S2`, 에이전트는
`S1-A1`, 외부 실행은 `X1`로만 나온다. 세션 ID·경로·프로젝트 폴더 이름은 HTML에 들어가지 않는다.
리포트의 모든 값은 쓰기 전에 내보내기 허용 목록(키 경로)과 값 검사(홈 경로, UUID, 요청 ID)를
통과해야 한다.

## 구조

| 부분 | 위치 | 역할 |
|---|---|---|
| 코어 기록기(mod) | `debrief/hooks/` | `<root>/runs/<프로젝트>/<세션>/<run>.json`을 쓴다. 코드에 벤더·머신·팀·사람 이름 없음 |
| 리포트 프로그램 | `debrief/tools/debrief_report/` | Python 3 표준 라이브러리만. 백필, AAR, 서머리, 압축, 장부 |
| 어댑터(선택) | 같은 프로그램 | 외부 에이전트 로그(Codex rollout)와 `/insights` 데이터. 없으면 조용히 건너뜀 |
| 프로필(선택) | `<root>/profile.json` | 언어, 직접 선언한 레인, 임계값, 외부 에이전트 유형. `/debrief setup`이 만든다. 저장소에 넣지 않는다. 프로필이 없으면 보고서와 setup 대화는 터미널 로케일(`LC_ALL`, 없으면 `LANG`: `ko_*`면 한국어, 그 외 영어)을 따른다 |

`<root>`는 `DEBRIEF_DIR`, 없으면 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/debrief`.

## 요구사항

- Claude Code 2.1.288 이상(mods는 얼리 액세스)
- macOS, Windows, Linux
- 리포트 명령에는 Python 3(설치할 패키지 없음). 없어도 기록기는 동작하고, 리포트 명령은 설치 안내만 출력한다.

## 설치

```
/plugin marketplace add matrix-freed/debrief
/plugin install debrief@debrief
```

Claude Code 2.1.275 이상에서는 한 줄로도 된다.

```
/plugin install debrief --marketplace matrix-freed/debrief
```

### Claude에게 설치 맡기기

Claude Code 세션에 그대로 붙여 넣는다.

```
debrief 플러그인을 설치해 줘. 마켓플레이스 matrix-freed/debrief 를 추가하고
debrief@debrief 를 설치한 뒤, 세션을 다시 시작하라고 알려 줘. 재시작 후 /debrief setup 을
실행해서 질문에 답하도록 안내해 줘. 다른 설정은 바꾸지 마.
```

## 명령

| 명령 | 하는 일 |
|---|---|
| `/debrief` | 이 세션의 숫자(모델·루프별 토큰, 비용, 시간, 에이전트) |
| `/debrief tag <라벨>` | 페이즈 표시. AAR 타임라인에 여기서 다음 태그까지 띠로 그린다 |
| `/debrief setup` | 프로필 만들기(언어, 레인, 임계값) |
| `/debrief aar [--from ISO] [--to ISO] [--cards 경로]` | 현재 프로젝트의 AAR HTML. `<root>/aar/` 아래에 쓴다 |
| `/debrief backfill [--days N]` | 지난 종료 세션을 transcript에서 가져온다(메타데이터만) |
| `/debrief compact [--dry-run]` | 30일 지난 run 파일을 월별 rollup으로 접고 원본은 아카이브로 옮긴다 |
| `/debrief ledger [list [--status S] \| set ID 상태]` | 개선 장부: proposed, applied, verified, dropped |

계획·실제·차이·개선 카드는 사람(또는 요청받은 세션)이 작은 `cards.json`에 쓴다. debrief는 판정
문장을 만들지 않는다. 개선 항목에는 장부 ID와 자기완결 적용 프롬프트, 복사 버튼이 붙는다.

## 리포트 프로그램 직접 실행

```
python3 debrief/tools/debrief_report backfill --config ~/.claude --root <root> --days 30
python3 debrief/tools/debrief_report aar --project <프로젝트 폴더 이름> --cards cards.json \
  --root <root> --tz +09:00 --out aar.html
python3 debrief/tools/debrief_report summary --session <세션 ID> --root <root> --out summary.html
python3 debrief/tools/debrief_report compact --root <root> --dry-run
python3 debrief/tools/debrief_report ledger --root <root> list
```

Windows에서는 `python3` 대신 `py -3`. 모든 명령은 마지막에 `RESULT {...}` 줄을 출력한다.

## 비용 표기

비용은 **"엔진 장부(API 환산), 세션 누적"**으로 표시한다. 엔진이 직접 쌓는 누적값을 run별 차로
더한 것이다. 구독 요금제에서는 청구액이 아니라 API 환산값이다. 장부가 없는 세션은 0으로 세고
추정으로 표시한다. 처리 토큰은 입력 + 캐시 쓰기 + 출력이고, 캐시 읽기는 따로 보여 준다.

## 프라이버시, 그리고 이것이 아닌 것

- 기록은 본인 PC에만 남는다. 업로드도, 서버도 없다.
- 사람별 순위나 비교는 없다. AAR은 프로젝트의 일하는 방식(시간과 토큰이 어디에 갔고 다음에 무엇을
  바꿀지)을 다루며, 가설은 판정이 아니라 질문으로 쓴다.
- 공유는 선택이다. 프로필 기본값은 `shareConsent: false`이고, 리포트에는 내보내기 허용 목록을
  통과한 값만 들어간다.

## 상태

P0(API 실측), P1(기록기), P2(리포트 프로그램, 백필, 프로젝트 AAR) 완료. `P0-RESULTS.md`,
`P1-RESULTS.md`, `P2-RESULTS.md` 참고. 첫 실데이터 AAR에서 확인한 알려진 갭:

- mod를 켜기 전에 기록된 세션은 비용 장부가 없다(0으로 세고 추정 표시)
- 자동 단발 SDK 세션은 간단한 규칙(진입점과 길이)으로 한 줄에 접는다
- 실험용으로 띄운 자식 세션은 부모가 `DEBRIEF_PARENT_SESSION`을 넘기지 않으면 부모 표식이 없다
- `--from/--to` 창은 세션을 고를 뿐 세션 안을 자르지 않는다
- 백필의 열린 세션 판정은 파일 유휴 시간 기준이다

## 라이선스

MIT. `LICENSE` 참고.
