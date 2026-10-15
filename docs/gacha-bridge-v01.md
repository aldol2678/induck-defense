# INDUCK-GACHA-BRIDGE-001 · First actual integration slice

## Dependency
Stacked Draft PR based on R0 Draft PR #1 branch `ccr-cd9ce6b1-u5hiww`. DO NOT merge into main until R0 is approved/merged. No deploy.

## What is wired now
- `public/gacha.html` is the frozen v0.4.1 Gacha Lab (plus a back link) loaded under the **same origin** as the Phaser game.
- The main game has a 🔬 Research button. Its modal reads *existing* Lab v0.4.1 localStorage `induck_gacha_demo_v01_20261015` without changing any IC, RC, purchases, rewards, or gacha RNG.
- The modal shows owned equipment blueprint count, skin count, and demo IC/RC balances; Lab opens in a separate browser tab, keeping the in-progress game intact.
- Independent academic ledger `induck_defense_academic_v01`: each of engineering/sports/humanities has Lv1–30, XP, and final research/operations branch at Lv27. A victory records **25 prototype XP** per major present in the **final unit lineup**, max once per browser run claim key. No XP if a major has no surviving unit at victory.
- Profile is local-only; corrupt input clamped; no direct writing to Lab currency, or INHA WORLD wallet.

## NOT yet implemented, intentionally
- Unlocked blueprints **do not create or equip actual battle gear**, do not buff unit stats, and do not spend per-run crafting resources.
- No unit innate rare traits, merge inheritance, research card drafting / effects, 8-level campus XP.
- No actual authenticated profile, server grants, persistent cross-device progression, production payment, wallet settlement, VIP game speed or XP booster.
- Academic 25 XP award is a **testing fixture**, not approved game economy.
- Browser localStorage is inherently editable; cannot be trusted for production entitlements/rewards.
- No change to R0 deterministic engine, fixed 50ms tick, summons RNG, map fixture, or existing save/replay contracts.

## Acceptance checks
1. After `npm ci && npm run dev`, open gameplay at `http://localhost:5173/`, start run, tap 🔬 Research between waves, open `/gacha.html`.
2. Draw one equipment blueprint in the lab; back in the game, reopen Research and verify blueprint count increases.
3. Win a 3-wave run; see XP recorded for the majors remaining in your final lineup. Restart does not reset permanent academic record.
4. Original R0 Vitest+Playwright suites pass unchanged; new `growthBridge.test.ts` should pass.
5. Cross-browser/same-origin condition matters: opening `file://` Lab outside the Vite origin WILL NOT share the demo inventory with localhost.

## Follow-up scope (implementation needed before claiming full integration)
- R1-B: item-per-unit equipment slot + in-run crafting and unlock validation; one item/slot; reversible merge. → Implemented as an opt-in test mode (`?r1=1`) in the stacked R1-B Draft PR; see `docs/growth-r1b.md`.
- R1-C: campus XP Lv1–8, deterministic seeded 3-choice research cards with R0 RNG stream unaffected, and real stat modifiers.
- R1-D: summon innate traits + merge inheritance, 30-stage unlocks & XP tuning, feature gating; user-approved balance.
- Security: replace localStorage with server-authenticated inventory and idempotent server reward ledger before any production shared IC integration.
