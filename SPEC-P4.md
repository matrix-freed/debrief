# debrief P4 — 빈 AAR 카드는 질문 창으로 묻는다

## 목표

`/debrief aar`를 `--cards` 없이 실행하면 계획·실제·차이·개선 네 칸이 "작성되지 않음"으로 끝난다.
debrief는 메타데이터만 다루므로 정상 동작이지만, 빈 채로 끝내지 않고 Claude가 곧바로 물어보게 한다.

## 동작

| 조건 | 사람이 보는 줄 | 모델 메모(`context`) | 질문 턴 제출 |
|---|---|---|---|
| `aar`, `--cards` 없음, exit 0, RESULT에 `output`, 대화형, 사람의 입력(`composer`·`bridge`) | RESULT + "리뷰 카드가 비어 있습니다 — 확인 창을 요청합니다" | 있음 | 있음(실패 시 대화에 안내 한 줄) |
| 위와 같으나 비대화형이거나 다른 출처(플러그인·모델) | RESULT + "…Claude에게 카드 작성을 요청하거나 --cards로 다시 생성하세요" | 있음 | 없음 |
| `--cards` 있음, 실패, `output` 없는 RESULT, 다른 하위 명령 | 기존 그대로 | 없음 | 없음 |

- 모델 메모(고정 한국어): AskUserQuestion으로 "AAR '계획·실제·차이·개선' 칸이 비어 있습니다. 어떻게 할까요?"
  선택지 ① 이 세션 내용으로 카드 작성 후 다시 생성(권장) ② 숫자만 두기. Other는 도구가 붙인다.
- ①이면 카드 JSON(`cards=[{k,title,body,evidence[]}]`, `improvements` 없음)을
  `<root>/aar/<slug>/<stamp>.cards.json`에 쓰고, 메모에 담긴 재생성 명령(같은 실행기·프로그램·`--root`·`--project`·
  `--config`·`--out`·사람이 준 `--from/--to/--no-ledger` + `--cards <파일>`)을 Bash로 실행한 뒤 `open`으로 연다.
  `--out`은 같은 파일이라 빈 카드 HTML을 덮어쓴다.
- 질문 턴: `$.prompt.submit({ text })`, 짧은 고정 문구. 엔진이 `command.run` 훅 안의 submit을 거부하므로
  (`it would wait on the turn this hook is holding`) `$.clock.after(0, …)`로 훅이 끝난 뒤 제출한다.
  `isMeta`는 플러그인이 못 정하므로 행은 "debrief 플러그인이 보낸 메시지"로 남는다.
  제출이 예외로 실패하거나 `{ drop }`이면 `$.ui.log`로 "확인 창을 띄우지 못했습니다 — Claude에게 카드 작성을
  요청하거나 --cards로 다시 생성하세요"를 남긴다(대화에 남고 모델에는 가지 않음). 명령은 제출 결과를 기다리지 않는다.

## `--no-ledger`

`aar`에서만 허용(값 없는 스위치, 중복 불가), 프로그램에 그대로 전달. 기본 동작(장부 등록)은 그대로.

## 원칙

run 기록에 프롬프트·답·경로 글을 저장하지 않는다. 메모와 제출 문구는 세션 transcript에만 있고 기록 파일에는 없다.
카드 파일은 사람이 승인한 산출물이라 예외(README 한 줄).
