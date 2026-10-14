# INDUCK-R0-001 · R0 테스트 보고서 (아테나 자체 검증)

> 작성: 아테나(Claude) · 2026-10-14 (UTC)
> **이 문서는 구현자 자체 검증이다.** 독립 QA(라온)·경로 검증(나루)·모바일 UX 검수(모아) 결과가 아니며, 이 보고서만으로 R0 완료를 선언하지 않는다(계약 §8).

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| 기준 커밋 | `main` @ `2d1a812732e900d3484df2cc5dc7244ceb88235b` (Initial README) |
| 작업 브랜치 | `ccr-cd9ce6b1-u5hiww` (최종 HEAD SHA는 PR 본문·결과 보고에 기재) |
| OS / 런타임 | Linux 6.18 (클라우드 컨테이너), Node.js 22.22.0, npm 10.9.4 |
| 브라우저 | Playwright 1.56.1 번들 Chromium (headless, build 1194) — **실기기 아님** |
| 맵 입력 | `src/data/maps/induck_defense_map_samples_R0.json`, SHA-256 `7e79062e2fe0abeb546a6dc25a7caa71c8a44467d5237bafd8371e9f8195a99b` (계약 스냅샷과 일치) |
| ruleset / seed | `R0` / QA seed `20261015` |

## 2. 실행 명령과 결과

| 명령 | 결과 | 원본 로그 |
|---|---|---|
| `npm run typecheck` | PASS (오류 0) | — |
| `npm test` (Vitest 4.1.11) | PASS 50/50 | [`vitest-output.txt`](vitest-output.txt) |
| `npm run build` (tsc + Vite 7.3.7) | PASS | [`build-output.txt`](build-output.txt) |
| `npm run test:e2e` (Playwright) | PASS 11/11 | [`e2e-output.txt`](e2e-output.txt) |
| `npm audit` | 취약점 0 | — |

## 3. 계약 §8 게이트 판정

| ID | 판정 | 근거 (테스트) | 비고 |
|---|---|---|---|
| MAP-01 | **PASS** (구현자) | `tests/core/mapValidation.test.ts` — 해시 일치, plaza 7×7·21점·28칸, lake 14/10·28칸, building5 10/9·29칸 모두 `ok` | 나루의 `map-validation-report.json` 교차 확인 필요 |
| MAP-02 | **PASS** (구현자) | 경로 끊김·물/벽/배치칸 침범·외부 좌표·S/B 불일치·출현점 누락·차원 오류·미지 타일·B 2개 → 각 오류 코드, 잘못된 맵은 세션 생성 거부 | 나루 독립 재현 필요 |
| RUN-01 | **PASS** | `movement.test.ts` — 매 tick 경로 중심선 위·S→…→B 순서 타일 방문, 적 6기 각 1회 도착, HP 10→4, 1.0칸/s에서 20칸=400±1 tick | 브라우저 화면에서도 S자 이동 관찰(스크린샷) |
| RUN-02 | **PASS** | `determinism.test.ts` — 동일 replay 20회 바이트 동일, 다른 seed는 결과 상이, 불규칙 프레임 실시간 세션 → replay 동일 상태. E2E `UI ↔ core sync` — 브라우저 세션 로그를 Node에서 재생해 Snapshot 완전 일치 | 나루 독립 재현 필요 |
| COMBAT-01 | **PASS** | `combat.test.ts` — 동일 seed·동일 유닛, 길 사이(2,2) 배치 vs 구석(0,6) 배치 → 처치 수·본부 HP 상이. 봇 비교: 길 옆 배치 59/60 승 vs 무작위 배치 11/60 승 | 라온 독립 검증 필요 |
| COMBAT-02 | **PASS** (구현자) | (0,6) 체대(사거리 1.4, 최근접 도로 중심 1.414)는 한 번도 발사 안 함 / 사망 적 추가 피해 0 / 잔여경로→spawnOrder→id 동률 규칙 / 전공별 쿨다운 18·20·14 tick | 라온 레드팀 필요 |
| INPUT-01 | **PASS** (자동화) | 단위: 이동·합성(대상 id 유지, ★+1, 쿨다운 0)·교환·제자리 no-op·탭 경로. E2E: 마우스 드래그로 이동/합성/교환, 탭-탭 이동, CDP 터치 드래그 이동 | 실기기 손맛 UNKNOWN |
| INPUT-02 | **PASS** (자동화) | 단위: 길·S·B·물·벽 `FORBIDDEN_TERRAIN`, 범위 밖 `OUT_OF_BOUNDS`, 상태 deep-equal 불변. E2E: 길/S/B 드롭 + 보드 밖 + 캔버스 밖 해제 + touchcancel → 원위치, 유닛·코인 불변 | 실기기 UNKNOWN |
| INPUT-03 | **PASS** | ★4 합성 `MAX_STAR`(교환 없음), 코인 19 `NO_FUNDS`, 28칸 가득 `BOARD_FULL` — 모두 RNG 포함 상태 불변 | — |
| WAVE-01 | **PASS** | 단위: 무방비 W1 HP 10→4, W2 패배 1회·이후 동결, RESTART=새 세션과 동일, PAUSE 동결. E2E: 패배 오버레이→재시작, QA seed 전체 플레이 → 승리 오버레이 | — |
| UI-01 | **PASS (에뮬레이션)** / 실기기 **UNKNOWN** | E2E 320×568·360×640·390×844(DPR 2, touch): `scrollHeight ≤ clientHeight+1`, 가로 넘침 없음, scrollY 0, 주요 버튼·HUD·캔버스·7×7 보드 전부 뷰포트 안, 칸 ≥ 36 CSS px | 브라우저 주소창·노치·safe-area 실측은 실기기 필요 |
| REG-01 | **PASS (자동화)** / 실기기 **UNKNOWN** | v0.2 핵심 동작 유지: 랜덤 소환 버튼, 손가락 위로 뜨는 드래그 고스트(1.17배·기울기), 빈 칸 이동·합성·교환, 탭 선택 대체 경로, 원위치 복귀 애니메이션, 일시정지/도움말 | v0.2의 강화·상점·보석은 R0 범위 밖이라 미이식 |
| SEC-01 | **PASS** (구현자) | 비밀정보·토큰·개인정보 없음, 외부 이미지/폰트/CDN 없음, 공식 인덕이·학교 에셋 없음, v0.2 HTML 코드 미복사(신규 작성), 의존성 라이선스 MIT/Apache-2.0/ISC/BSD-3 | 맵 JSON 공개 여부는 설계자 확인 요청(§5) |

**실기기에서 확인하지 않은 항목은 PASS로 표시하지 않았다.** 위 "PASS (에뮬레이션/자동화)"는 headless Chromium 기준이다.

## 4. 스크린샷 (`docs/qa/screenshots/`)

| 파일 | 내용 |
|---|---|
| `320x568-title.png`, `360x640-title.png`, `390x844-title.png` | 시작 안내 오버레이 |
| `320x568-battle.png`, `360x640-battle.png`, `390x844-battle.png` | 웨이브 1 진행 중 전투 화면 |
| `touch-drag-ghost.png` | 터치 드래그 중 고스트·이동 미리보기·사거리 원 |
| `input-merge.png`, `tap-select-range.png` | 합성 직후 / 탭 선택 사거리 표시 |
| `390x844-midwave.png`, `390x844-victory.png`, `390x844-defeat.png` | 전체 플레이 중반 / 승리 / 패배 |

## 5. 알려진 제한·위험

1. **실기기 미검증:** iOS Safari·Android Chrome 실제 터치, 주소창 높이 변화, 노치 safe-area, 진동 피드백, 프레임 안정성은 확인하지 못함.
2. **맵 JSON 공개:** 런타임 데이터라 공개 레포에 바이트 동일 사본을 포함함(격자·좌표·장소명만, 비밀정보 없음). 설계자가 공개를 원치 않으면 BLOCKED 처리 후 대체 필요.
3. **밸런스는 시험값:** 웨이브·적 수치는 테스트 가능성 기준 fixture(`fixtures/r0/ruleset.json`). 봇 기준 난이도이며 사람 플레이테스트 전.
4. **문과대생 약점 효과·웨이브 보너스는 계약 확장(PROPOSED)** — `docs/implementation-plan.md` §6.
5. 번들 크기 약 1.25 MB(gzip 348 KB) — 대부분 Phaser. 저속망 첫 로딩 지연 가능.
6. 라이선스 미정 저장소 — 외부 기여·재사용 조건 미결.
