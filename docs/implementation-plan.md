# INDUCK-R0-001 · implementation-plan (아테나)

계약서 R0.1(§3.3 "실제 디렉터리·모듈 구조는 레포 준비 후 implementation-plan에 기록")에 따른 구현 기록.

## 1. 기술 스택과 의존성

| 구분 | 선택 | 버전 | 라이선스 |
|---|---|---|---|
| 렌더링 | Phaser 3 | 3.90.0 (고정) | MIT |
| 언어 | TypeScript | 5.9.3 | Apache-2.0 |
| 번들러 | Vite | 7.3.7 | MIT |
| 단위 테스트 | Vitest | 4.1.11 | MIT |
| 브라우저 E2E | @playwright/test | 1.56.1 | Apache-2.0 |

- 전체 설치 트리 라이선스: MIT·Apache-2.0·ISC·BSD-3-Clause만 존재 (copyleft 없음). `npm audit` 0건.
- vitest 3.x는 `tinypool`(critical)·`@vitest/mocker`(moderate) 권고가 있어 수정된 4.1.11 사용.
- `.npmrc`의 `legacy-peer-deps=true`: npm 10.9의 선택적 peer 해석 버그(`edgesOut` 오류) 회피용. 실제 런타임 의존성에는 영향 없음.
- 외부 폰트·이미지·CDN 없음. 모든 그래픽은 런타임 절차적 도형(`src/game/art.ts`)이며 공식 인덕이·학교 에셋을 포함하지 않음.

## 2. 디렉터리

```
fixtures/r0/ruleset.json          R0 테스트 fixture (전공 수치·적·웨이브·코인) — 확정 밸런스 아님
src/data/maps/…_R0.json           맵 원본 (계약 SHA-256 7e79062e…a99b와 바이트 동일)
src/core/                         ← DOM/Phaser 없는 순수 TS 전투 코어
  types.ts                        계약 §3–§4 타입 (MapDefinition, GameState, PlayerCommand, DomainEvent …)
  rng.ts                          mulberry32 기준 알고리즘, seed 검증
  mapValidation.ts                validateMap / validateMapDefinition (계약 오류 코드)
  engine.ts                       createSession / applyCommand / step / stepWithEvents / getSnapshot
  replay.ts                       replay log 형식 + runReplay
  controller.ts                   실시간 구동기: 누적기 → 50ms 고정 틱, replay 기록
  catalog.ts                      맵 카탈로그 로드 + 원본 해시 상수
src/game/                         ← Phaser 렌더·입력 계층 (Snapshot만 읽음)
  BattleScene.ts                  타일맵, 유닛/적 표시, 드래그·탭 입력, 시각 효과
  art.ts                          절차적 플레이스홀더 아트
src/ui/hud.ts                     DOM HUD (HP·코인·웨이브·버튼·오버레이)
src/main.ts                       부트스트랩, ?seed= 처리, QA 훅
tests/core/*.test.ts              헤드리스 엔진 테스트 (Vitest)
e2e/mobile.spec.ts                Chromium 모바일 뷰포트·포인터 E2E (Playwright)
```

## 3. 계약 API 대응

| 계약 §3.3 | 구현 |
|---|---|
| `validateMap(catalog, mapId)` | `src/core/mapValidation.ts` — 계약 코드 10종 + `MAP_NOT_FOUND`(카탈로그에 없는 id), `PATH_DUPLICATE`(다른 경로와 완전히 동일), `PATH_REVISIT`(한 경로 안에서 이미 지난 칸 재방문) — 후자 2종은 STABILIZE-001 D1·D2 |
| `createSession({map, seed, ruleset:'R0'})` | `engine.ts` — 잘못된 맵이면 `MapValidationError` throw(게임 시작 실패), 잘못된 seed는 Error |
| `applyCommand(state, cmd): CommandResult` | `engine.ts` — 거부 시 상태·코인·쿨다운·RNG 불변(테스트로 deep-equal 확인) |
| `step(state, fixedTicks)` | `engine.ts` — 1 tick = 50 ms. 이벤트가 필요하면 `stepWithEvents` |
| `getSnapshot(state)` | `engine.ts` — 적 월드좌표·잔여경로, 유닛 사거리·데미지 포함 |

## 4. 판정 규칙 (구현 세부)

**한 tick 순서** (계약 §5.5): 명령(입력 큐 순) → 스폰 → 약점 타이머 감소 → 유닛 공격(유닛 생성 순, hitscan, 즉시 피해/사망 정산) → 생존 적 이동 → 본부 도착·HP 정산 → 패배 우선 판정 → 웨이브 종료/승리.

- **이동:** `speedCellsPerSecond × 0.05` 거리를 세그먼트 단위로 소비, 잔여 거리는 다음 세그먼트로 이월. B 중심 도착 시 1회만 정산 후 제거.
- **타깃:** 유닛 타일 중심 ↔ 적 보간 좌표 유클리드 거리 ≤ 사거리. 잔여 경로 최소 → `spawnOrder` → id 숫자 오름차순.
- **쿨다운:** 발사 시 `round(attackMs/50)` 틱(공대 18·체대 20·문과 14). 소환 직후·합성 직후 0이라 사거리 안에 적이 있으면 즉시 발사.
- **데미지:** `round(base × (1 + 0.55 × (★−1)))` → 공대 4/6/8/11, 체대 7/11/15/19, 문과 3/5/6/8.
- **RNG 소비 순서:** 소환 1회 = ① 전공 `floor(r×3)` (engineering, sports, humanities 순) ② 빈 `.` 칸 `floor(r×n)` (행 우선 y→x 정렬). 그 외 RNG 소비 없음. 실패한 소환은 RNG를 건드리지 않음.
- **DROP_UNIT:** 빈 `.` 이동 / 같은 전공·★(<4) 합성(대상 id 유지·★+1·쿨다운 0, 드래그 유닛 제거) / ★4끼리 `MAX_STAR`(교환 없음) / 그 밖 유닛 교환 / 금지 타일 `FORBIDDEN_TERRAIN` / 범위 밖 `OUT_OF_BOUNDS` / 제자리 no-op 성공.
- **웨이브:** `spawned === plannedSpawns && enemies.length === 0` → `WAVE_CLEARED`. 3웨이브 클리어 시 `victory`. HP 0이면 같은 tick에 클리어 조건이 맞아도 `defeat` 우선.
- **일시정지/정지 구간:** `ready`(START_RUN 전), `PAUSE`, `victory`/`defeat`에서는 tick 자체가 진행하지 않음.

## 5. 입력·UX 경로

- 드래그: pointerdown → 140 ms 홀드 또는 7 CSS px 이동 시 "들기"(1.17배, 손가락 위로 띄운 고스트, 원래 칸 반투명). 드롭 판정은 **손가락 좌표**의 칸으로만 하며 고스트는 판정에 불참.
- 들고 있는 동안: 모든 `.` 칸 테두리, 합성 가능 칸 금색, 현재 칸은 이동(초록)/합성(금)/교환(파랑)/불가(빨강) + 라벨, 그 칸 기준 사거리 원 미리보기.
- 캔버스 밖에서 손을 떼기(`pointerupoutside`)·`pointercancel`·창 blur·오버레이 열림·일시정지 = 명령 없이 원위치 복귀.
- 탭: 유닛 탭 → 선택(사거리 표시) → 다른 칸 탭 → 동일 `DROP_UNIT`. 길게 눌렀다 제자리에 놓으면 선택(사거리 확인).
- 오버레이 버튼은 열린 뒤 250 ms 동안 입력 무시(팝업 직전 터치가 선택으로 새는 것 방지). 탭이 숨겨지면 자동 일시정지.
- `touch-action: none`은 `#game` 캔버스 영역에만 적용. 문서 높이는 `100dvh` + `overflow:hidden`.

## 6. 계약 대비 확장·변경 제안 (PROPOSED CHANGE — 승인 필요)

| # | 항목 | 내용 | 영향 |
|---|---|---|---|
| P1 | 문과대생 `expose` 효과 | 맞은 적은 2초간 받는 피해 ×1.25 (반올림). 사용자 지시 "3종 기본 전투 역할"을 위해 fixture `majors.humanities.effect`로 구현. 공대·체대 특수효과(포탑·넉백)는 R2 이후. | 전투 결과 변화. fixture에서 `effect: null`로 끄면 계약 원안과 동일 |
| P2 | `waveClearBonus: 20` | 웨이브 클리어 시 +20 코인 | 경제 |
| P3 | 웨이브 fixture | W1 과제×6(1.5s 간격, HP×2.0) / W2 8기(1.3s, ×3.8, 중간고사 1) / W3 12기(1.1s, ×5.6, 중간고사 3). 적: 과제 HP16·1.0칸/s·피해1, 쪽지시험 HP10·1.6칸/s·피해1, 중간고사 HP45·0.7칸/s·피해2 | 밸런스(시험값) |
| P4 | GameState 추가 필드 | `paused, seed, totalWaves, spawnCooldownTicks, maxBaseHp, selectedUnitId, kills, leaks, map, rules`, Enemy `kind, spawnOrder, exposedTicks` | 직렬화 상태 확장(계약 §4.1 "확장 가능") |
| P5 | 이벤트 선택 필드 | `ENEMY_DAMAGED/KILLED`에 `unitId, amount`, 합성/교환에 `otherUnitId` | 연출용, 판정 영향 없음 |
| P6 | `ready` 단계 tick 정지 | START_RUN 전에는 tick 미진행 | replay 해석 명확화 |
| P7 | `GOAL_MISMATCH` 정의 | 그리드의 B가 정확히 1개가 아니거나, 경로 끝점이 그 B와 다르면 발생 | 검증 규칙 해석 |
| P8 | 단순 경로 정책 (D1·D2) | 동일 경로 중복 등록 `PATH_DUPLICATE`, 경로 내 칸 재방문 `PATH_REVISIT`. 서로 다른 출현점 경로의 부분 합류는 허용 | 신규 오류 코드 2종 |

밸런스 근거(시드 1..60, 헤드리스 봇): 길 옆 배치+합성 봇 59/60 승, 무작위 배치 봇 11/60 승, 유닛 없음 = 2웨이브 패배.

## 7. R1 호환성

- 엔진은 `enemy.pathIndex`로 경로를 참조하므로 `paths[1]` 동시 진입은 스폰 규칙만 추가하면 됨. 현재 R0 런타임은 `plaza.paths[0]`만 사용.
- `lake`·`building5`는 `validateMap`으로 데이터 검증만 수행(테스트 MAP-01). 물(`~`)·벽(`X`) 드롭 금지는 타일 기반 규칙으로 이미 적용.
