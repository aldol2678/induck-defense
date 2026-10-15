// Phaser render + input layer. Reads RenderSnapshot only; every player action becomes a
// PlayerCommand through GameController. Visual effects never feed back into the core.
import Phaser from 'phaser';
import type { GameController } from '../core/controller';
import type { DomainEvent, Major, MapDefinition, Point, RejectReason, RenderSnapshot, UnitView } from '../core/types';
import { ENEMY_STYLE, generateTextures, MAJOR_STYLE, TEX } from './art';

export type SceneHooks = {
  controller: GameController;
  map: MapDefinition;
  onFrame(snapshot: RenderSnapshot): void;
  onReject(reason: RejectReason): void;
  onHint(text: string): void;
};

type UnitSprite = {
  root: Phaser.GameObjects.Container;
  duck: Phaser.GameObjects.Image;
  star: Phaser.GameObjects.Text;
  key: string;
  cellKey: string;
};

type EnemySprite = {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Image;
  hp: Phaser.GameObjects.Graphics;
  mark: Phaser.GameObjects.Text;
  lastHp: number;
  lastExposed: boolean;
};

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  cell: Point;
  unitId: string | null;
  lifted: boolean;
  liftTimer?: Phaser.Time.TimerEvent;
  ghost?: Phaser.GameObjects.Container;
  hoverLabel?: Phaser.GameObjects.Text;
};

const LIFT_DELAY_MS = 140;
const LIFT_DISTANCE_CSS_PX = 7;

const COLORS = {
  frame: 0x7696a8,
  frameFill: 0xd6eef8,
  buildA: 0xeaf5f1,
  buildB: 0xcfe3dc,
  buildEdge: 0x9fbfc7,
  road: 0xdcc9a2,
  roadEdge: 0xb59f74,
  roadMark: 0xf6ead0,
  spawn: 0xe57a6c,
  base: 0x4c91c8,
  water: 0x6fc3e6,
  wall: 0x7d8796,
  valid: 0x6fe39a,
  merge: 0xffd34d,
  swap: 0x7cc4ff,
  invalid: 0xff5d6c,
};

export class BattleScene extends Phaser.Scene {
  private hooks!: SceneHooks;
  private dpr = 1;
  private tile = 40;
  private ox = 0;
  private oy = 0;
  private boardGfx!: Phaser.GameObjects.Graphics;
  private highlightGfx!: Phaser.GameObjects.Graphics;
  private rangeGfx!: Phaser.GameObjects.Graphics;
  /** Clips range previews to the 7×7 board so they never spill onto the background. */
  private rangeMaskGfx!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private enemyLayer!: Phaser.GameObjects.Container;
  private fxLayer!: Phaser.GameObjects.Container;
  private labels: Phaser.GameObjects.Text[] = [];
  private units = new Map<string, UnitSprite>();
  private enemies = new Map<string, EnemySprite>();
  private lastEnemyPos = new Map<string, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private snap!: RenderSnapshot;
  private hoverCell: Point | null = null;
  private baseFlash = 0;

  constructor() {
    super('battle');
  }

  init(hooks: SceneHooks): void {
    this.hooks = hooks;
  }

  create(): void {
    this.dpr = Number(this.game.registry.get('dpr') ?? 1);
    generateTextures(this);
    this.boardGfx = this.add.graphics();
    this.highlightGfx = this.add.graphics();
    this.rangeGfx = this.add.graphics();
    this.rangeMaskGfx = this.make.graphics({ x: 0, y: 0 }, false);
    this.rangeGfx.setMask(this.rangeMaskGfx.createGeometryMask());
    this.enemyLayer = this.add.container();
    this.unitLayer = this.add.container();
    this.fxLayer = this.add.container();
    this.snap = this.hooks.controller.getSnapshot();

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onPointerDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, () => this.cancelGesture(), this);
    this.game.canvas.addEventListener('pointercancel', () => this.cancelGesture());
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.cancelGesture());

    this.hooks.controller.onEvents((events) => this.playEvents(events));
    this.scale.on(Phaser.Scale.Events.RESIZE, () => this.layout());
    this.layout();
  }

  // ------------------------------------------------------------------ layout

  layout(): void {
    const { width, height } = this.scale.gameSize;
    const map = this.hooks.map;
    const pad = 6 * this.dpr;
    this.tile = Math.floor(Math.min((width - pad * 2) / map.width, (height - pad * 2) / map.height));
    this.ox = Math.round((width - this.tile * map.width) / 2);
    // Spare vertical space goes mostly above the board so a lifted unit (drawn above the finger) stays visible.
    const slackY = Math.max(0, height - this.tile * map.height - pad * 2);
    const headroom = Math.min(slackY, this.tile * 0.9);
    this.oy = Math.round(pad + headroom + (slackY - headroom) / 2);
    this.rangeMaskGfx.clear().fillStyle(0xffffff).fillRect(this.ox, this.oy, this.tile * map.width, this.tile * map.height);
    this.drawBoard();
    for (const s of this.units.values()) s.root.destroy();
    this.units.clear();
    for (const s of this.enemies.values()) s.root.destroy();
    this.enemies.clear();
    this.cancelGesture();
  }

  private center(p: Point): { x: number; y: number } {
    return { x: this.ox + (p.x + 0.5) * this.tile, y: this.oy + (p.y + 0.5) * this.tile };
  }

  private world(x: number, y: number): { x: number; y: number } {
    return { x: this.ox + x * this.tile, y: this.oy + y * this.tile };
  }

  /** Integer cell under a game-space point; may be outside the map (engine rejects it). */
  private cellAt(px: number, py: number): Point {
    return { x: Math.floor((px - this.ox) / this.tile), y: Math.floor((py - this.oy) / this.tile) };
  }

  private tileAt(p: Point): string | undefined {
    return this.hooks.map.grid[p.y]?.[p.x];
  }

  private drawBoard(): void {
    const g = this.boardGfx;
    const map = this.hooks.map;
    const t = this.tile;
    g.clear();
    for (const l of this.labels) l.destroy();
    this.labels = [];

    const fw = 4 * this.dpr;
    g.fillStyle(COLORS.frameFill, 0.92).lineStyle(fw, COLORS.frame);
    g.fillRoundedRect(this.ox - fw * 1.5, this.oy - fw * 1.5, t * map.width + fw * 3, t * map.height + fw * 3, 14 * this.dpr);
    g.strokeRoundedRect(this.ox - fw * 1.5, this.oy - fw * 1.5, t * map.width + fw * 3, t * map.height + fw * 3, 14 * this.dpr);

    const gap = Math.max(2, t * 0.05);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const c = map.grid[y]![x];
        const px = this.ox + x * t;
        const py = this.oy + y * t;
        if (c === '.') {
          g.fillStyle((x + y) % 2 ? COLORS.buildA : COLORS.buildB).lineStyle(1.5 * this.dpr, COLORS.buildEdge);
          g.fillRoundedRect(px + gap, py + gap, t - gap * 2, t - gap * 2, t * 0.16);
          g.strokeRoundedRect(px + gap, py + gap, t - gap * 2, t - gap * 2, t * 0.16);
          g.fillStyle(0xffffff, 0.45).fillRoundedRect(px + gap * 2, py + gap * 2, t - gap * 4, t * 0.14, t * 0.06);
        } else if (c === '~') {
          g.fillStyle(COLORS.water).fillRect(px, py, t, t);
        } else if (c === 'X') {
          g.fillStyle(COLORS.wall).fillRect(px + 1, py + 1, t - 2, t - 2);
        } else {
          g.fillStyle(COLORS.road).fillRect(px, py, t, t);
        }
      }
    }
    // road edges + centre markings along the ordered path
    const path = map.paths[0]!;
    g.lineStyle(t * 0.06, COLORS.roadMark, 0.9);
    for (let i = 0; i < path.length - 1; i++) {
      const a = this.center(path[i]!);
      const b = this.center(path[i + 1]!);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const s = t * 0.13;
      g.beginPath();
      g.moveTo(mx - Math.cos(ang - 0.6) * s, my - Math.sin(ang - 0.6) * s);
      g.lineTo(mx, my);
      g.lineTo(mx - Math.cos(ang + 0.6) * s, my - Math.sin(ang + 0.6) * s);
      g.strokePath();
    }
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const c = map.grid[y]![x];
        if (c === 'S') this.drawSpawn({ x, y });
        if (c === 'B') this.drawBase({ x, y });
      }
    }
  }

  private drawSpawn(p: Point): void {
    const g = this.boardGfx;
    const t = this.tile;
    const { x, y } = this.center(p);
    g.fillStyle(COLORS.spawn).lineStyle(2 * this.dpr, 0x8e3b33);
    g.fillRoundedRect(x - t * 0.42, y - t * 0.42, t * 0.84, t * 0.84, t * 0.2);
    g.strokeRoundedRect(x - t * 0.42, y - t * 0.42, t * 0.84, t * 0.84, t * 0.2);
    g.fillStyle(0x5a2320).fillRoundedRect(x - t * 0.24, y - t * 0.2, t * 0.48, t * 0.58, { tl: t * 0.24, tr: t * 0.24, bl: 0, br: 0 });
    this.labels.push(this.label(x, y - t * 0.3, '출현', 0xffffff, 0.2));
    this.labels.push(this.label(x, y + t * 0.1, '▶', 0xffd3c8, 0.3));
  }

  private drawBase(p: Point): void {
    const g = this.boardGfx;
    const t = this.tile;
    const { x, y } = this.center(p);
    g.fillStyle(COLORS.base).lineStyle(2 * this.dpr, 0x234d72);
    g.fillRoundedRect(x - t * 0.44, y - t * 0.44, t * 0.88, t * 0.88, t * 0.18);
    g.strokeRoundedRect(x - t * 0.44, y - t * 0.44, t * 0.88, t * 0.88, t * 0.18);
    g.fillStyle(0xf4f7fb).fillRect(x - t * 0.26, y - t * 0.06, t * 0.52, t * 0.36);
    g.fillStyle(0xd65656).fillTriangle(x - t * 0.32, y - t * 0.04, x + t * 0.32, y - t * 0.04, x, y - t * 0.28);
    g.fillStyle(0x5b88b3).fillRect(x - t * 0.07, y + t * 0.1, t * 0.14, t * 0.2);
    g.lineStyle(2 * this.dpr, 0xffffff).lineBetween(x + t * 0.2, y - t * 0.2, x + t * 0.2, y - t * 0.42);
    g.fillStyle(0xffd75e).fillTriangle(x + t * 0.2, y - t * 0.42, x + t * 0.38, y - t * 0.36, x + t * 0.2, y - t * 0.3);
    this.labels.push(this.label(x, y + t * 0.36, '본부', 0xffffff, 0.19));
  }

  private label(x: number, y: number, text: string, color: number, sizeRatio: number): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, text, {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.max(9, Math.round(this.tile * sizeRatio))}px`,
        color: `#${color.toString(16).padStart(6, '0')}`,
        stroke: '#203450',
        strokeThickness: Math.max(2, this.tile * 0.05),
      })
      .setOrigin(0.5)
      .setDepth(1);
  }

  // ------------------------------------------------------------------ frame

  update(_time: number, delta: number): void {
    const c = this.hooks.controller;
    c.advance(delta);
    this.snap = c.getSnapshot();
    if (this.gesture && (this.snap.paused || !['intermission', 'wave'].includes(this.snap.phase))) this.cancelGesture();
    this.syncUnits();
    this.syncEnemies(c.alpha);
    this.drawOverlays();
    this.hooks.onFrame(this.snap);
  }

  private makeUnitContainer(u: Pick<UnitView, 'major' | 'star'>): Omit<UnitSprite, 'key' | 'cellKey'> {
    const t = this.tile;
    const duck = this.add.image(0, 0, `duck-${u.major}`).setScale((t * 0.94) / TEX);
    const star = this.add
      .text(t * 0.44, -t * 0.42, `★${u.star}`, {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(t * 0.2)}px`,
        color: '#ffffff',
        backgroundColor: '#3d6890',
        padding: { x: Math.round(t * 0.04), y: 0 },
      })
      .setOrigin(1, 0);
    const badge = this.add
      .text(-t * 0.44, t * 0.42, MAJOR_STYLE[u.major].badge, {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(t * 0.19)}px`,
        color: '#20344f',
        backgroundColor: MAJOR_STYLE[u.major].css,
        padding: { x: Math.round(t * 0.04), y: 0 },
      })
      .setOrigin(0, 1);
    const root = this.add.container(0, 0, [duck, star, badge]);
    return { root, duck, star };
  }

  private syncUnits(): void {
    const seen = new Set<string>();
    const dragging = this.gesture?.lifted ? this.gesture.unitId : null;
    for (const u of this.snap.units) {
      seen.add(u.id);
      const key = `${u.major}-${u.star}`;
      const cellKey = `${u.cell.x},${u.cell.y}`;
      const pos = this.center(u.cell);
      let s = this.units.get(u.id);
      if (!s) {
        const parts = this.makeUnitContainer(u);
        s = { ...parts, key, cellKey };
        s.root.setPosition(pos.x, pos.y);
        this.unitLayer.add(s.root);
        this.units.set(u.id, s);
        s.root.setScale(0.4);
        this.tweens.add({ targets: s.root, scale: 1, duration: 260, ease: 'Back.Out' });
      }
      if (s.key !== key) {
        s.duck.setTexture(`duck-${u.major}`);
        s.star.setText(`★${u.star}`);
        s.key = key;
        s.root.setScale(1.35);
        this.tweens.add({ targets: s.root, scale: 1, duration: 280, ease: 'Back.Out' });
      }
      if (s.cellKey !== cellKey) {
        s.cellKey = cellKey;
        this.tweens.killTweensOf(s.root);
        this.tweens.add({ targets: s.root, x: pos.x, y: pos.y, scale: 1, duration: 140, ease: 'Quad.Out' });
      }
      s.root.setAlpha(dragging === u.id ? 0.3 : 1);
      s.duck.y = Math.sin((this.time.now / 1000) * 3 + u.cell.x) * this.tile * 0.02;
    }
    for (const [id, s] of this.units) {
      if (!seen.has(id)) {
        this.units.delete(id);
        this.tweens.add({ targets: s.root, scale: 0.2, alpha: 0, duration: 160, onComplete: () => s.root.destroy() });
      }
    }
  }

  private syncEnemies(alpha: number): void {
    const t = this.tile;
    const seen = new Set<string>();
    for (const e of this.snap.enemies) {
      seen.add(e.id);
      let s = this.enemies.get(e.id);
      if (!s) {
        const body = this.add.image(0, 0, `enemy-${e.kind}`).setScale((t * (ENEMY_STYLE[e.kind]?.scale ?? 0.6)) / TEX);
        const hp = this.add.graphics();
        const mark = this.add
          .text(0, t * 0.36, '약점!', {
            fontFamily: 'system-ui, sans-serif',
            fontStyle: '900',
            fontSize: `${Math.round(t * 0.16)}px`,
            color: '#ffffff',
            backgroundColor: '#5b4bb7',
          })
          .setOrigin(0.5)
          .setVisible(false);
        s = { root: this.add.container(0, 0, [body, hp, mark]), body, hp, mark, lastHp: -1, lastExposed: false };
        this.enemyLayer.add(s.root);
        this.enemies.set(e.id, s);
      }
      const prev = this.hooks.controller.previousPosition(e.id) ?? e;
      const x = prev.x + (e.x - prev.x) * alpha;
      const y = prev.y + (e.y - prev.y) * alpha;
      const p = this.world(x, y);
      const bob = Math.sin(this.time.now / 120 + e.spawnOrder) * t * 0.03;
      s.root.setPosition(p.x, p.y);
      s.body.y = bob;
      this.lastEnemyPos.set(e.id, p);
      if (s.lastHp !== e.hp) {
        s.lastHp = e.hp;
        const w = t * 0.62;
        const h = Math.max(3, t * 0.08);
        s.hp.clear();
        s.hp.fillStyle(0x10192b).fillRect(-w / 2 - 1, -t * 0.4 - 1, w + 2, h + 2);
        s.hp.fillStyle(0x551f36).fillRect(-w / 2, -t * 0.4, w, h);
        s.hp.fillStyle(0xff6477).fillRect(-w / 2, -t * 0.4, (w * Math.max(0, e.hp)) / e.maxHp, h);
      }
      if (s.lastExposed !== e.exposed) {
        s.lastExposed = e.exposed;
        s.mark.setVisible(e.exposed);
        s.body.setTint(e.exposed ? 0xd8ccff : 0xffffff);
      }
    }
    for (const [id, s] of this.enemies) {
      if (!seen.has(id)) {
        this.enemies.delete(id);
        s.root.destroy();
      }
    }
  }

  private drawOverlays(): void {
    const t = this.tile;
    const hg = this.highlightGfx;
    const rg = this.rangeGfx;
    hg.clear();
    rg.clear();
    const map = this.hooks.map;
    const g = this.gesture;

    if (this.baseFlash > 0) {
      this.baseFlash = Math.max(0, this.baseFlash - this.game.loop.delta / 400);
      const b = map.paths[0]![map.paths[0]!.length - 1]!;
      hg.fillStyle(0xff3045, this.baseFlash * 0.6).fillRect(this.ox + b.x * t, this.oy + b.y * t, t, t);
    }

    let rangeUnit: UnitView | undefined;
    let rangeCell: Point | undefined;
    if (g?.lifted && g.unitId) {
      const dragged = this.snap.units.find((u) => u.id === g.unitId);
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          if (map.grid[y]![x] !== '.') continue;
          const other = this.snap.units.find((u) => u.cell.x === x && u.cell.y === y);
          const mergeable = !!(dragged && other && other.id !== dragged.id && other.major === dragged.major && other.star === dragged.star && other.star < 4);
          hg.lineStyle(2 * this.dpr, mergeable ? COLORS.merge : COLORS.valid, mergeable ? 0.95 : 0.45);
          hg.strokeRoundedRect(this.ox + x * t + 3, this.oy + y * t + 3, t - 6, t - 6, t * 0.16);
        }
      }
      if (this.hoverCell && dragged) {
        const hc = this.hoverCell;
        const kind = this.dropKind(dragged, hc);
        const color = kind === 'merge' ? COLORS.merge : kind === 'swap' ? COLORS.swap : kind === 'invalid' ? COLORS.invalid : COLORS.valid;
        const inside = hc.x >= 0 && hc.y >= 0 && hc.x < map.width && hc.y < map.height;
        if (inside) {
          hg.fillStyle(color, 0.38).fillRoundedRect(this.ox + hc.x * t + 2, this.oy + hc.y * t + 2, t - 4, t - 4, t * 0.16);
          hg.lineStyle(3 * this.dpr, color, 1).strokeRoundedRect(this.ox + hc.x * t + 2, this.oy + hc.y * t + 2, t - 4, t - 4, t * 0.16);
        }
        g.hoverLabel?.setText(
          kind === 'merge' ? `합성 ★${dragged.star + 1}` : kind === 'swap' ? '자리 교환' : kind === 'move' ? '이동' : kind === 'same' ? '제자리' : '배치 불가',
        );
        g.hoverLabel?.setBackgroundColor(kind === 'invalid' ? '#c43a4a' : kind === 'merge' ? '#b8860b' : '#2f5f86');
        rangeUnit = dragged;
        rangeCell = kind === 'invalid' ? dragged.cell : hc;
      }
    } else if (this.snap.selectedUnitId) {
      rangeUnit = this.snap.units.find((u) => u.id === this.snap.selectedUnitId);
      rangeCell = rangeUnit?.cell;
      if (rangeUnit) {
        hg.lineStyle(3 * this.dpr, 0xffe061, 1);
        hg.strokeRoundedRect(this.ox + rangeUnit.cell.x * t + 2, this.oy + rangeUnit.cell.y * t + 2, t - 4, t - 4, t * 0.16);
      }
    }
    if (rangeUnit && rangeCell) {
      const c = this.center(rangeCell);
      const col = Phaser.Display.Color.HexStringToColor(MAJOR_STYLE[rangeUnit.major].css).color;
      rg.fillStyle(col, 0.14).fillCircle(c.x, c.y, rangeUnit.range * t);
      rg.lineStyle(2 * this.dpr, col, 0.9).strokeCircle(c.x, c.y, rangeUnit.range * t);
      // board edge = where the (clipped) range ends
      hg.lineStyle(2 * this.dpr, 0x2f5f86, 0.75).strokeRect(this.ox, this.oy, t * map.width, t * map.height);
    }
  }

  private dropKind(dragged: UnitView, cell: Point): 'move' | 'merge' | 'swap' | 'invalid' | 'same' {
    if (this.tileAt(cell) !== '.') return 'invalid';
    if (cell.x === dragged.cell.x && cell.y === dragged.cell.y) return 'same';
    const other = this.snap.units.find((u) => u.cell.x === cell.x && u.cell.y === cell.y);
    if (!other) return 'move';
    if (other.major === dragged.major && other.star === dragged.star) return other.star >= 4 ? 'invalid' : 'merge';
    return 'swap';
  }

  // ------------------------------------------------------------------ input

  private canInteract(): boolean {
    return !this.snap.paused && (this.snap.phase === 'intermission' || this.snap.phase === 'wave');
  }

  private unitAt(p: Point): UnitView | undefined {
    return this.snap.units.find((u) => u.cell.x === p.x && u.cell.y === p.y);
  }

  private onPointerDown(p: Phaser.Input.Pointer): void {
    if (this.gesture) {
      // A gesture whose pointer is no longer down lost its release event: cancel instead of locking input.
      const owner = this.input.manager.pointers.find((pp) => pp.id === this.gesture!.pointerId);
      if (owner?.isDown && owner !== p) return;
      this.cancelGesture();
    }
    if (!this.canInteract()) return;
    const cell = this.cellAt(p.x, p.y);
    const unit = this.unitAt(cell);
    this.gesture = { pointerId: p.id, startX: p.x, startY: p.y, cell, unitId: unit?.id ?? null, lifted: false };
    if (unit) {
      this.gesture.liftTimer = this.time.delayedCall(LIFT_DELAY_MS, () => this.lift(p));
    }
  }

  private lift(p: Phaser.Input.Pointer): void {
    const g = this.gesture;
    if (!g || g.lifted || !g.unitId) return;
    const u = this.snap.units.find((x) => x.id === g.unitId);
    if (!u) return;
    g.lifted = true;
    g.liftTimer?.remove();
    const parts = this.makeUnitContainer(u);
    g.ghost = parts.root.setDepth(50).setScale(1.17);
    g.hoverLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(this.tile * 0.2)}px`,
        color: '#ffffff',
        backgroundColor: '#2f5f86',
        padding: { x: 6, y: 2 },
      })
      .setOrigin(0.5, 1)
      .setDepth(51);
    this.moveGhost(p.x, p.y);
    if (navigator.vibrate) {
      try {
        navigator.vibrate(9);
      } catch {
        /* optional */
      }
    }
  }

  /** The ghost floats above the finger; the drop is judged at the finger, not the ghost. */
  private moveGhost(px: number, py: number): void {
    const g = this.gesture;
    if (!g?.ghost) return;
    const dx = px - g.startX;
    const t = this.tile;
    g.ghost.setPosition(px, Math.max(py - t * 0.55, t * 0.5));
    g.ghost.setAngle(Phaser.Math.Clamp(dx * 0.05, -12, 12));
    const lh = g.hoverLabel?.height ?? 0;
    const lw = (g.hoverLabel?.width ?? 0) / 2;
    const { width } = this.scale.gameSize;
    g.hoverLabel?.setPosition(Phaser.Math.Clamp(px, lw + 2, width - lw - 2), Math.max(py - t * 1.12, lh + 2));
    this.hoverCell = this.cellAt(px, py);
  }

  private onPointerMove(p: Phaser.Input.Pointer): void {
    const g = this.gesture;
    if (!g || p.id !== g.pointerId) return;
    if (!g.lifted && g.unitId && Math.hypot(p.x - g.startX, p.y - g.startY) > LIFT_DISTANCE_CSS_PX * this.dpr) this.lift(p);
    if (g.lifted) this.moveGhost(p.x, p.y);
  }

  private onPointerUp(p: Phaser.Input.Pointer): void {
    const g = this.gesture;
    if (!g || p.id !== g.pointerId) return;
    g.liftTimer?.remove();
    const c = this.hooks.controller;
    const cell = this.cellAt(p.x, p.y);
    if (g.lifted && g.unitId) {
      const from = this.snap.units.find((u) => u.id === g.unitId);
      const same = from && from.cell.x === cell.x && from.cell.y === cell.y;
      if (same) {
        // long-press and release in place → select (shows range), same as a tap
        c.dispatch({ type: 'SELECT_UNIT', unitId: g.unitId });
        this.finishGhost(cell, true);
      } else {
        const r = c.dispatch({ type: 'DROP_UNIT', unitId: g.unitId, to: cell });
        if (!r.accepted && r.reason) this.hooks.onReject(r.reason);
        this.finishGhost(r.accepted ? cell : (from?.cell ?? g.cell), r.accepted);
      }
    } else {
      this.handleTap(cell);
    }
    this.clearGesture(false);
  }

  private handleTap(cell: Point): void {
    const c = this.hooks.controller;
    const here = this.unitAt(cell);
    const selected = this.snap.selectedUnitId;
    if (selected) {
      if (here?.id === selected) {
        c.dispatch({ type: 'CANCEL_SELECTION' });
        return;
      }
      const r = c.dispatch({ type: 'DROP_UNIT', unitId: selected, to: cell });
      if (!r.accepted) {
        if (r.reason) this.hooks.onReject(r.reason);
        c.dispatch({ type: 'CANCEL_SELECTION' });
      }
      return;
    }
    if (here) {
      c.dispatch({ type: 'SELECT_UNIT', unitId: here.id });
      const rule = here;
      this.hooks.onHint(`${MAJOR_LABEL[here.major]} ★${here.star} · 사거리 ${rule.range}칸 · 공격 ${rule.damage} · 옮길 칸 탭`);
    } else if (this.tileAt(cell) === '.') {
      this.hooks.onHint('빈 칸 — 소환하면 빈 칸 중 한 곳에 나타나요');
    } else if (this.tileAt(cell)) {
      this.hooks.onHint('길·출현지·본부에는 둘 수 없어요');
    }
  }

  private finishGhost(cell: Point, accepted: boolean): void {
    const g = this.gesture;
    if (!g?.ghost) return;
    const ghost = g.ghost;
    const target = this.center(cell);
    g.hoverLabel?.destroy();
    this.tweens.add({
      targets: ghost,
      x: target.x,
      y: target.y,
      angle: 0,
      scale: accepted ? 0.9 : 1,
      alpha: 0.15,
      duration: accepted ? 160 : 200,
      ease: accepted ? 'Cubic.Out' : 'Back.Out',
      onComplete: () => ghost.destroy(),
    });
    g.ghost = undefined;
    g.hoverLabel = undefined;
  }

  /** Drag cancelled (pointer cancel, leaving the canvas, overlay, pause): no command, ghost returns home. */
  cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    g.liftTimer?.remove();
    if (g.ghost) {
      const from = this.snap?.units.find((u) => u.id === g.unitId);
      this.finishGhost(from?.cell ?? g.cell, false);
    }
    this.clearGesture(true);
  }

  private clearGesture(destroyGhost: boolean): void {
    if (destroyGhost) {
      this.gesture?.ghost?.destroy();
      this.gesture?.hoverLabel?.destroy();
    }
    this.gesture = null;
    this.hoverCell = null;
  }

  // ------------------------------------------------------------------ effects (visual only)

  private playEvents(events: DomainEvent[]): void {
    const t = this.tile;
    for (const e of events) {
      switch (e.type) {
        case 'ENEMY_DAMAGED': {
          const u = this.snap.units.find((x) => x.id === e.unitId) ?? this.hooks.controller.getSnapshot().units.find((x) => x.id === e.unitId);
          const to = this.lastEnemyPos.get(e.enemyId);
          if (!u || !to) break;
          const from = this.center(u.cell);
          this.shot(u.major, from, to);
          this.floatText(to.x + Phaser.Math.Between(-4, 4), to.y - t * 0.3, `-${e.amount}`, '#ffffff', 0.2);
          break;
        }
        case 'ENEMY_KILLED': {
          const p = this.lastEnemyPos.get(e.enemyId);
          if (!p) break;
          this.burst(p.x, p.y, 0xffe28a);
          this.floatText(p.x, p.y - t * 0.15, `+${e.amount}🪙`, '#ffe06a', 0.22);
          this.lastEnemyPos.delete(e.enemyId);
          break;
        }
        case 'ENEMY_REACHED_BASE':
          this.baseFlash = 1;
          this.cameras.main.shake(140, 0.006);
          break;
        case 'UNIT_MERGED': {
          const u = this.hooks.controller.getSnapshot().units.find((x) => x.id === e.unitId);
          if (u) {
            const c = this.center(u.cell);
            this.burst(c.x, c.y, 0xfff3a0, 10);
            this.floatText(c.x, c.y - t * 0.45, `합성! ★${u.star}`, '#fff3a0', 0.24);
          }
          break;
        }
        case 'WAVE_STARTED':
          this.banner(`WAVE ${e.wave}`);
          break;
        default:
          break;
      }
    }
  }

  private shot(major: Major, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const t = this.tile;
    const color = Phaser.Display.Color.HexStringToColor(MAJOR_STYLE[major].css).color;
    if (major === 'sports') {
      const ring = this.add.circle(to.x, to.y, t * 0.18, color, 0.5).setStrokeStyle(3 * this.dpr, 0xffffff);
      this.fxLayer.add(ring);
      this.tweens.add({ targets: ring, scale: 1.8, alpha: 0, duration: 180, onComplete: () => ring.destroy() });
      return;
    }
    const dot = this.add.image(from.x, from.y, 'dot').setTint(color).setScale((t * 0.16) / 16);
    this.fxLayer.add(dot);
    this.tweens.add({ targets: dot, x: to.x, y: to.y, duration: 110, onComplete: () => dot.destroy() });
  }

  private burst(x: number, y: number, color: number, n = 6): void {
    const t = this.tile;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      const d = this.add.image(x, y, 'dot').setTint(color).setScale((t * 0.12) / 16);
      this.fxLayer.add(d);
      this.tweens.add({ targets: d, x: x + Math.cos(a) * t * 0.5, y: y + Math.sin(a) * t * 0.5, alpha: 0, duration: 320, onComplete: () => d.destroy() });
    }
  }

  private floatText(x: number, y: number, text: string, color: string, size: number): void {
    const tx = this.add
      .text(x, y, text, {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(this.tile * size)}px`,
        color,
        stroke: '#203450',
        strokeThickness: Math.max(2, this.tile * 0.06),
      })
      .setOrigin(0.5);
    this.fxLayer.add(tx);
    this.tweens.add({ targets: tx, y: y - this.tile * 0.4, alpha: 0, duration: 650, onComplete: () => tx.destroy() });
  }

  private banner(text: string): void {
    const { width, height } = this.scale.gameSize;
    const tx = this.add
      .text(width / 2, height * 0.45, text, {
        fontFamily: 'system-ui, sans-serif',
        fontStyle: '900',
        fontSize: `${Math.round(this.tile * 0.7)}px`,
        color: '#ffffff',
        stroke: '#2a5a93',
        strokeThickness: this.tile * 0.12,
      })
      .setOrigin(0.5)
      .setDepth(60)
      .setScale(0.6)
      .setAlpha(0);
    this.tweens.add({ targets: tx, scale: 1, alpha: 1, duration: 260, yoyo: true, hold: 600, onComplete: () => tx.destroy() });
  }
}

const MAJOR_LABEL: Record<Major, string> = { engineering: '공대생', sports: '체대생', humanities: '문과대생' };
