# debrief P3 결과 — 저장소 정리 · 공개 준비

> **결론:** 범위 7개 중 로컬에서 할 수 있는 것은 모두 끝냈다. 공개 전 점검(`scripts/precheck.py`)은 추적 파일 69개에서 비밀값·금지 이름·식별자·로컬 데이터 모두 0건, exit 0이다. 다만 **git 기록**(커밋 메시지 7개, 과거 버전 파일)에는 내부 이름과 경로가 남아 있어, public 전환 전에 히스토리 처리 방식을 정해야 한다(3절, G4).

## 1. 범위별 결과

| 항목 | 판정 | 내용 |
|---|---|---|
| README.md 전면 작성 | PASS | 영어 먼저, 한국어 전문 아래(254줄). 기록 항목과 비기록 목록, 구조, 설치 두 줄과 한 줄 설치, Claude에게 설치 맡기기 프롬프트(영·한), 요구사항, 명령 표, 리포트 직접 실행, 비용 표기, 프라이버시 문단, 상태와 알려진 갭, 라이선스 |
| LICENSE | PASS | MIT, `Copyright (c) 2026 matrix-freed` |
| `.claude-plugin/marketplace.json` | PASS | name `debrief`, owner `matrix-freed`, plugins `debrief`(source `./debrief`, version 0.1.0). P0 probe는 목록에서 뺐다(폴더는 설계 근거로 남김). `claude plugin validate .` 통과 |
| 로컬 마켓플레이스 정리 | PASS | 이 폴더의 개발용 등록 `debrief-dev`를 지우고 `debrief`(local scope)로 다시 등록, `.claude/settings.local.json`도 같은 이름으로(git 밖, 백업 `.local/settings.local.json.bak`). 두 플러그인은 원래대로 비활성 |
| `scripts/precheck.py` | PASS | 추적 파일 전체에서 (a) 비밀값 (b) 금지 이름(`.local/precheck-names.txt`, git 밖, 없으면 SKIP) (c) 홈 경로·실제 UUID·요청 ID (d) 로컬·실데이터 경로. 결과 0건, exit 0. 임시 저장소에 네 범주 표본을 넣어 각각 검출되는 것도 확인(5건, exit 1) |
| probe와 결과 문서 정리 | PASS | probe의 원격 레인 예시 이름을 중립 이름(`remote-host`, `remoteDirective`)으로, 결과 문서·스펙·픽스처 메모의 내부 리뷰어 이름과 개인 계정 폴더명·볼트 경로를 일반 표현으로. probe 테스트 4건, debrief 테스트 36건 통과 |
| 버전·태그 | PASS | `debrief/.claude-plugin/plugin.json` 0.1.0(+ `license: MIT`), 로컬 태그 `v0.1.0`. 태그는 push하지 않았다 |
| P3-RESULTS.md | PASS | 이 문서 |

## 2. precheck 규칙과 예외

- 이름: 영문은 단어 경계로, 한글 두 글자 이상은 부분 일치, 한 글자 성씨는 단독이거나 호칭이 붙을 때만(일상어 속 글자 오탐 방지).
- UUID: 서로 다른 문자가 6개 이하인 합성 ID(`aaaaaaaa-0000-4000-8000-…`)는 제외.
- 합성 픽스처 폴더는 가짜 경로·ID를 일부러 담고 있어 (c)(d)를 건너뛴다. (a)(b)는 그대로 검사.
- 의도적으로 패턴을 담은 줄(검출기 자신의 정규식, 테스트의 가짜 홈 경로, 폰트 이름 `Apple SD Gothic Neo`)은 `precheck: allow` 표식으로 제외. 표식이 붙은 파일은 7개다(검출기 자신 포함).
- (d)는 파일 경로 기준이다. 문서 안의 `.local/` 언급(명령 예시)은 데이터가 아니라서 검사하지 않는다.

## 3. 남은 G4 사항(저장소 소유자 결정)

1. **git 기록 처리.** 현재 파일은 깨끗하지만 기록에는 남아 있다: 커밋 메시지 7개에 내부 리뷰어 이름, 과거 버전의 probe 코드·P0 문서에 원격 레인 이름, 과거 스펙·픽스처에 홈 경로 형태 문자열(합성 표식 포함). 선택지: (가) 현재 트리를 한 커밋으로 새 public 저장소에 올림 — 권고, 되돌리기 쉽고 기존 private 기록은 보존 (나) 히스토리 재작성 후 강제 push (다) 그대로 공개.
2. public 전환, 원격 태그 `v0.1.0` push.
3. 시범 파트원 설치(README의 설치 두 줄 또는 Claude에게 맡기기 프롬프트).
4. 팀 상시 실행 머신 설치(별도 처리).

## 4. 보류

- OTel 비교: 이번 범위 밖, 보류.
- Windows 실기기 확인: 단위 테스트(`py -3` 대체 경로)만 했다.
- G3 재작성 AAR 화면은 P2-RESULTS 8절. 같은 시각 다른 워크트리용 변형 비교 브리프가 `.local`에 있으나 이 세션 범위가 아니다.

## 5. 명령

```
python3 scripts/precheck.py                       # 0건, exit 0
claude plugin validate .                          # 마켓플레이스
claude plugin validate debrief && claude plugin test debrief    # 36 pass
claude plugin test probe                          # 4 pass
cd debrief/tools/debrief_report && python3 -m unittest discover -s tests   # 38 OK
git tag v0.1.0                                    # 로컬만
```
