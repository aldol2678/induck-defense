# Induck Defense

Status: Early prototype / Work in progress — **R0 (중앙광장 전투 실증)**

모바일 세로 한 화면에서 즐기는 캠퍼스 디펜스 프로토타입. 적(과제·쪽지시험·중간고사)이 중앙광장 7×7 맵의 지정 경로를 따라 본부로 이동하고, 공대생·체대생·문과대생 인덕이를 랜덤 소환·드래그 배치·합성해 막아 냅니다.

## 실행

Node.js 20+ (검증: 22.22.0, npm 10.9.4)

```bash
npm ci                 # 의존성 설치
npm run dev            # 개발 서버 → 터미널에 표시된 URL (같은 Wi-Fi의 휴대폰에서도 접속 가능)
npm run build && npm run preview   # 프로덕션 빌드 확인
```

- `?seed=20261015` 처럼 시드를 지정하면 같은 입력에서 같은 전투가 재현됩니다(없으면 무작위 시드, 일시정지 메뉴에 표시).

## 검증

```bash
npm run typecheck      # tsc --noEmit
npm test               # 헤드리스 전투 엔진 테스트 (Vitest)
npm run test:e2e       # Chromium 모바일 뷰포트 E2E (Playwright, 빌드+preview 서버 자동 실행)
```

Playwright 브라우저가 없으면 `npx playwright install chromium` 후 실행하세요.

## 구조

- `src/core/` — DOM/Phaser 없는 결정론적 전투 코어 (50 ms 고정 틱, mulberry32 시드 RNG)
- `src/game/`, `src/ui/` — Phaser 3 렌더링·입력, DOM HUD (코어의 Snapshot만 읽고 명령만 보냄)
- `src/data/maps/` — 맵 데이터 JSON (plaza 실전투, lake·building5는 데이터 검증만)
- `fixtures/r0/` — R0 테스트용 수치 fixture (확정 밸런스 아님)
- `docs/implementation-plan.md` — 계약 대응·판정 규칙·변경 제안
- `docs/qa/` — 테스트 결과 보고서와 뷰포트 스크린샷

## 자산·라이선스 메모

- 그래픽은 모두 코드로 그린 임시 도형입니다. 공식 인덕이·학교 로고 등 권리 확인이 필요한 에셋은 포함하지 않습니다.
- 저장소 라이선스는 아직 정해지지 않았습니다. 공개 저장소라는 사실이 오픈소스 사용 허가를 뜻하지 않습니다.
