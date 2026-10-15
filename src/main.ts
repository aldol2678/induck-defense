import Phaser from 'phaser';
import './style.css';
import { getMap, R0_MAP_ID } from './core/catalog';
import { GameController } from './core/controller';
import { isValidSeed } from './core/rng';
import { BattleScene, type SceneHooks } from './game/BattleScene';
import { readGachaOverview } from './ui/growthBridge';
import { Hud, REJECT_TEXT } from './ui/hud';

/** Seed choice is the only non-gameplay randomness; ?seed=N reproduces a run exactly. */
function newSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
const param = new URLSearchParams(location.search).get('seed');
const parsed = param !== null && /^\d+$/.test(param) ? Number(param) : NaN;
const seed = isValidSeed(parsed) ? parsed : newSeed();

// R1-B growth test mode (?r1=1): owned Gacha Lab blueprints are snapshotted once at load
// (local demo data, read-only). Without the flag the game is the unchanged R0 session.
const growthMode = new URLSearchParams(location.search).get('r1') === '1';
const growth = growthMode ? { blueprints: readGachaOverview().equipmentIds } : undefined;

const map = getMap(R0_MAP_ID);
const controller = new GameController(map, seed, growth);
let scene: BattleScene | null = null;

const hud = new Hud({
  controller,
  newSeed,
  onOverlayChange: () => scene?.cancelGesture(),
});

const host = document.getElementById('game')!;
const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
const size = () => ({ w: Math.max(1, Math.round(host.clientWidth * dpr)), h: Math.max(1, Math.round(host.clientHeight * dpr)) });
const initial = size();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: host,
  width: initial.w,
  height: initial.h,
  transparent: true,
  antialias: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
  input: { activePointers: 2 },
  banner: false,
  callbacks: {
    preBoot: (g) => g.registry.set('dpr', dpr),
  },
});

const hooks: SceneHooks = {
  controller,
  map,
  onFrame: (s) => hud.update(s),
  onReject: (reason) => hud.toast(REJECT_TEXT[reason]),
  onHint: (text) => hud.hint(text),
  onMergeChoice: (unitId, to) => hud.showMergeChoice(unitId, to),
};
game.scene.add('battle', BattleScene, true, hooks);
game.events.once(Phaser.Core.Events.READY, () => {
  scene = game.scene.getScene('battle') as BattleScene;
});

new ResizeObserver(() => {
  const { w, h } = size();
  if (w !== game.scale.gameSize.width || h !== game.scale.gameSize.height) {
    game.scale.setGameSize(w, h);
    game.scale.refresh();
  }
}).observe(host);

hud.showTitle();

// QA hook for automated viewport / input tests (read-only snapshot + command bridge).
declare global {
  interface Window {
    __INDUCK_QA__?: unknown;
  }
}
window.__INDUCK_QA__ = {
  snapshot: () => controller.getSnapshot(),
  dispatch: (cmd: Parameters<GameController['dispatch']>[0]) => controller.dispatch(cmd),
  replay: () => controller.exportReplay(),
  /** CSS-pixel client coordinates of a cell centre (for real pointer drags in tests). */
  cellToClient: (x: number, y: number) => {
    const s = game.scene.getScene('battle') as unknown as { center(p: { x: number; y: number }): { x: number; y: number } };
    const c = s.center({ x, y });
    const rect = game.canvas.getBoundingClientRect();
    return { x: rect.left + (c.x / game.scale.gameSize.width) * rect.width, y: rect.top + (c.y / game.scale.gameSize.height) * rect.height };
  },
  overlayOpen: () => hud.overlayOpen,
};
