# INDUCK-R0-STABILIZE-001 · 안정화 결과 (아테나)

> 기준 HEAD: `ee2a46d653a62de5b92e1441c32a6925ec9073c6` (Draft PR #1, 브랜치 `ccr-cd9ce6b1-u5hiww`) — 착수 시 원격 HEAD와 일치 확인
> 범위: 독립 QA 반영(나루 D1·D2, 모아 관찰 1~3) + GitHub Actions CI. 신규 기능·밸런스 변경 없음.
> 이 문서는 구현자 기록이며 나루·라온·모아의 재검증을 대신하지 않는다.

## P1 · 맵 검증기 (나루 D1·D2)

| 결함 | 수정 전 | 수정 후 |
|---|---|---|
| D1 동일 경로 2회 등록 | 통과 (`ok: true`) | `PATH_DUPLICATE` (`pathIndex` = 나중 경로) |
| D2 경로 내 칸 재방문 A→B→A | 통과 | `PATH_REVISIT` (`at` = 처음 재방문한 칸) |
| 서로 다른 출현점 경로의 부분 합류 | 허용 | 허용 유지 (building5 두 경로 공유 칸 > 1 확인) |
| plaza / lake / building5 원본 | ok | ok, JSON 바이트 SHA-256 불변 |

- 재현: [`d1-d2-before-fix.txt`](d1-d2-before-fix.txt) (수정 전 신규 테스트 2건 FAIL) → [`vitest-output.txt`](vitest-output.txt) (수정 후 54/54 PASS)
- 테스트: `tests/core/mapValidation.test.ts` › `MAP-03` (4건 추가)
- 코드: `src/core/mapValidation.ts`, `src/core/types.ts` (오류 코드 2종 추가)

## P2 · 모바일 UX (모아 관찰 1~3)

| 관찰 | 변경 | 수정 전 → 후 (320×568) |
|---|---|---|
| 1. 보조 문구 8~10px | 로고 부제·웨이브 정보·안내·전공 칩 글자 확대, 안내 문구를 짧게 줄여 한 줄 유지 | 로고 부제 8→10px · 웨이브 정보/안내 10→11px · 전공 칩 9→11px · 칩 수치 7.5→10px |
| 2. 시작 모달 어절 중간 줄바꿈 | 모달·토스트에 `word-break: keep-all` | "랜/덤" 분리 해소 |
| 3. 사거리 원이 보드 밖까지 표시 | 사거리 원을 7×7 보드 영역으로 잘라 그리고(geometry mask) 보드 테두리 표시 | 보드 밖 배경에 그려지지 않음 |

- 3종 뷰포트 모두 문서 스크롤 0, 텍스트 잘림 없음: [`before/metrics.json`](before/metrics.json) / [`after/metrics.json`](after/metrics.json)
- 같은 장면 비교 캡처(`scripts/compare-screens.mjs`): `before/` · `after/` 폴더의 `{320x568,360x640,390x844}-title.png`, `-range-left.png`
- E2E `UI-01`에 회귀 검사 추가: 보조 텍스트 ≥ 10px, 잘림 없음, 모달 `keep-all`
- 드래그·합성·교환·탭 선택·터치 취소 E2E 회귀: 전부 PASS (헤드리스 Chromium)
- **실기기(iOS Safari·Android Chrome): UNKNOWN** — 접근 수단 없음. 에뮬레이션 PASS로 대체하지 않음.

## P3 · GitHub Actions CI

- `.github/workflows/ci.yml`: `pull_request` + `main` push만 트리거(PR 브랜치 중복 실행 방지), 같은 PR은 `concurrency`로 이전 실행 취소, `contents: read` 권한.
- 잡 2개, 단계별 이름 분리:
  - `typecheck · unit · build · audit`: `npm ci` → Typecheck → Unit tests → Build → `npm audit`
  - `e2e (Playwright Chromium, mobile viewports)`: `npm ci` → Chromium 설치 → `npm run test:e2e` → 결과·스크린샷 아티팩트(7일)
- 실제 실행 결과는 PR #1의 Checks 탭과 Slack 결과 보고에 run URL로 기록. **이 문서의 로컬 로그는 CI PASS의 근거가 아님.**

## P4 · 보존 확인

- 전투 규칙·RNG·tick·replay·fixture(`fixtures/r0/ruleset.json`) 변경 없음 — 기존 Vitest 50건·E2E 11건 수정·삭제 없이 통과.
- 미승인 시험값(문과대 ×1.25, 웨이브 +20, HP 2.0/3.8/5.6) 유지 · 맵 JSON 공개 여부는 설계자 미결 · 라이선스 미추가 · 공식/학교 에셋 없음.

## 로컬 실행 결과 (Node 22.22.0, headless Chromium 1194)

| 명령 | 결과 | 로그 |
|---|---|---|
| `npm run typecheck` | PASS | [`typecheck-output.txt`](typecheck-output.txt) |
| `npm test` | PASS 54/54 (기존 50 + 신규 4) | [`vitest-output.txt`](vitest-output.txt) |
| `npm run build` | PASS | [`build-output.txt`](build-output.txt) |
| `npm audit` | 0 vulnerabilities | [`audit-output.txt`](audit-output.txt) |
| `npm run test:e2e` | PASS 11/11 | [`e2e-output.txt`](e2e-output.txt) |
