// DOM HUD: top stats, wave bar, action buttons and overlays. Reads snapshots, sends commands.
import type { GameController } from '../core/controller';
import { R0_RULES } from '../core/engine';
import {
  canEquip,
  CRAFT_COST,
  getEquipment,
  getTrait,
  TRAIT_TIER_LABEL,
  UNSUPPORTED_LABEL,
  type TraitDef,
} from '../core/growth';
import type { DomainEvent, Major, Point, RejectReason, RenderSnapshot } from '../core/types';
import { MAJOR_STYLE } from '../game/art';
import { academicTitle, chooseBranch, readAcademic, readGachaOverview, recordVictory, xpToNext } from './growthBridge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const REJECT_TEXT: Record<RejectReason, string> = {
  OUT_OF_BOUNDS: '배치판 밖이에요 — 원래 자리로 돌아가요',
  FORBIDDEN_TERRAIN: '길·출현지·본부에는 배치할 수 없어요',
  NO_UNIT: '그 인덕이를 찾을 수 없어요',
  NO_FUNDS: '🪙 코인이 부족해요',
  BOARD_FULL: '빈 칸이 없어요! 같은 전공·같은 ★끼리 합성해 보세요',
  PHASE_BLOCKED: '지금은 할 수 없어요',
  MAX_STAR: '★4는 더 이상 합성할 수 없어요',
  INVALID_STATE: '잘못된 요청이에요',
  GROWTH_DISABLED: 'R1 성장 시험 모드에서만 쓸 수 있어요',
  NOT_OWNED: '가챠 연구소에서 얻은 설계도가 없어요',
  UNSUPPORTED_OPTION: '아직 전투에 구현되지 않은 장비 옵션이에요',
  NO_ITEM: '그 장비를 찾을 수 없어요',
  NOT_EQUIPPED: '장착한 장비가 없어요',
  MAJOR_MISMATCH: '이 전공은 장착할 수 없는 장비예요',
  CHOICE_REQUIRED: '합성할 때 남길 특성을 골라 주세요',
};

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const traitText = (t: TraitDef | undefined) => (t ? `${t.label} <small>(${TRAIT_TIER_LABEL[t.tier]} · ${t.desc})</small>` : '없음');
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** R1 growth test mode is opt-in via ?r1=1; plain R0 stays the default. */
function modeUrl(r1: boolean): string {
  const url = new URL(location.href);
  if (r1) url.searchParams.set('r1', '1');
  else url.searchParams.delete('r1');
  return url.pathname + url.search;
}

const MAJORS: Major[] = ['engineering', 'sports', 'humanities'];

export type HudOptions = {
  controller: GameController;
  onOverlayChange(open: boolean): void;
  newSeed(): number;
};

export class Hud {
  private last = '';
  private toastTimer = 0;
  private overlayOpenedAt = 0;
  private overlayKind: string | null = null;
  private rewardSession = String(Date.now()) + ':' + String(crypto.getRandomValues(new Uint32Array(1))[0]);
  private rewardOrdinal = 0;
  private pendingMerge: { unitId: string; to: Point } | null = null;

  constructor(private readonly opts: HudOptions) {
    this.renderMajors();
    $('summonBtn').addEventListener('click', () => this.command({ type: 'SUMMON' }, '✦ 새 인덕이가 합류했어요!'));
    $('waveBtn').addEventListener('click', () => this.command({ type: 'START_WAVE' }));
    $('pauseBtn').addEventListener('click', () => this.pause());
    $('helpBtn').addEventListener('click', () => this.showHelp());
    $('researchBtn').addEventListener('click', () => this.showResearch());
    $('majors').addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-major]');
      if (chip) this.showMajor(chip.dataset.major as Major);
    });
    $('modal').addEventListener('click', (e) => this.onModalClick(e));
    opts.controller.onEvents((events, snap) => this.onEvents(events, snap));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
  }

  private get c(): GameController {
    return this.opts.controller;
  }

  private command(cmd: Parameters<GameController['dispatch']>[0], okToast?: string): void {
    const r = this.c.dispatch(cmd);
    if (!r.accepted && r.reason) this.toast(REJECT_TEXT[r.reason]);
    else if (okToast) this.toast(okToast);
  }

  // ---------------------------------------------------------------- per frame

  update(s: RenderSnapshot): void {
    const key = [s.phase, s.paused, s.coin, s.baseHp, s.wave, s.spawned, s.plannedSpawns, s.enemies.length, s.canSummon, s.units.length].join('|');
    if (key === this.last) return;
    this.last = key;
    $('hp').textContent = String(s.baseHp);
    $('hpMax').textContent = String(s.maxBaseHp);
    $('coin').textContent = String(s.coin);
    $('cost').textContent = String(s.summonCost);
    $('waveLabel').textContent = `WAVE ${s.wave}/${s.totalWaves}`;
    const remaining = s.plannedSpawns - s.spawned + s.enemies.length;
    const info =
      s.phase === 'wave'
        ? `남은 적 ${remaining}/${s.plannedSpawns}`
        : s.phase === 'intermission'
          ? s.wave === 0
            ? '배치 시간 · 준비되면 ▶'
            : `WAVE ${s.wave} 방어 성공 · 정비 시간`
          : s.phase === 'victory'
            ? '중앙광장 방어 완료!'
            : s.phase === 'defeat'
              ? '본부가 함락됐어요'
              : '준비 중';
    $('waveInfo').textContent = s.paused ? '일시정지' : info;
    const pct = s.phase === 'wave' && s.plannedSpawns ? (100 * (s.plannedSpawns - remaining)) / s.plannedSpawns : s.phase === 'victory' ? 100 : 0;
    $('waveBar').style.width = `${pct}%`;
    $<HTMLButtonElement>('summonBtn').disabled = !s.canSummon;
    const waveBtn = $<HTMLButtonElement>('waveBtn');
    waveBtn.disabled = s.paused || s.phase !== 'intermission';
    $('waveBtnText').textContent = s.phase === 'wave' ? '진행 중' : s.wave === 0 ? '전투 시작' : `WAVE ${s.wave + 1}`;
    $<HTMLButtonElement>('pauseBtn').disabled = !(s.phase === 'wave' || s.phase === 'intermission');
    if (s.phase === 'intermission' && s.units.length === 0) this.hint('🪙 소환한 인덕이를 길 옆으로 옮기세요');
    else if (s.phase === 'intermission' && s.wave === 0) this.hint('같은 전공·★끼리 겹치면 합성 · ▶ 전투 시작');
    else if (s.phase === 'wave') this.hint('끌어서 이동 · 같은 전공·★ 합성 · 교환');
  }

  hint(text: string): void {
    const n = $('note');
    if (n.textContent !== text) n.textContent = text;
  }

  toast(text: string): void {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
  }

  private onEvents(events: DomainEvent[], snap: RenderSnapshot): void {
    for (const e of events) {
      if (e.type === 'BASE_HP_CHANGED') {
        const pill = $('hpPill');
        pill.classList.remove('hit');
        void pill.offsetWidth;
        pill.classList.add('hit');
      } else if (e.type === 'UNIT_MERGED') {
        const u = snap.units.find((x) => x.id === e.unitId);
        if (u) this.toast(`✨ 합성 성공! ${MAJOR_STYLE[u.major].short} ★${u.star}`);
      } else if (e.type === 'UNIT_SWAPPED') {
        this.toast('↔ 자리를 바꿨어요');
      } else if (e.type === 'WAVE_CLEARED' && snap.phase === 'intermission') {
        this.toast(`🏆 WAVE ${e.wave} 방어 성공! 보너스 +${R0_RULES.waveClearBonus}🪙`);
      } else if (e.type === 'GAME_WON') {
        recordVictory(this.rewardSession + ':' + this.rewardOrdinal, snap.units.map(u => u.major));
        this.showEnd(true, snap);
      } else if (e.type === 'GAME_LOST') {
        this.showEnd(false, snap);
      }
    }
  }

  // ---------------------------------------------------------------- overlays

  get overlayOpen(): boolean {
    return this.overlayKind !== null;
  }

  private open(kind: string, html: string, refresh = false): void {
    this.overlayKind = kind;
    // A refresh re-renders the same dialog in place; keep the original input-transition guard time.
    if (!refresh) this.overlayOpenedAt = performance.now();
    $('modal').innerHTML = html;
    $('overlay').hidden = false;
    this.opts.onOverlayChange(true);
  }

  private close(): void {
    this.overlayKind = null;
    $('overlay').hidden = true;
    this.opts.onOverlayChange(false);
  }

  showTitle(): void {
    const s = this.c.getSnapshot();
    this.open(
      'title',
      `<h2>🦆 중앙광장 방어전</h2>
      <p>캠퍼스 중앙광장에 <b>과제·쪽지시험·중간고사</b>가 몰려와요! 출현지에서 S자 길을 따라 <b>본부</b>로 향하는 적을 인덕이들이 막아야 해요.</p>
      <div class="help">🪙 <b>소환</b> — 공대생·체대생·문과대생 중 랜덤<br>👆 <b>드래그</b> — 빈 칸 이동 · 같은 전공·★ 합성 · 다른 인덕이와 교환<br>🎯 인덕이는 각자 사거리 안의 적을 자동 공격 — <b>길 가까이</b> 둘수록 유리<br>🛡️ 적이 본부에 닿으면 HP 감소 · 3 웨이브를 막으면 승리</div>
      <button class="btn" data-act="start">전투 준비 ▶</button>
      ${s.growth ? '<p class="desc">🧰 <b>R1-B 성장 시험 모드</b> — 소환된 인덕이마다 고유 특성이 붙고, 🔬 연구 화면의 장비 공방에서 장비를 만들어 장착할 수 있어요. 수치는 시험값이에요.</p>' : ''}
      <div class="seed">seed ${s.seed} · ruleset R0${s.growth ? ' + R1-B growth (test)' : ''} · map plaza</div>`,
    );
  }

  private pause(): void {
    const s = this.c.getSnapshot();
    if (this.overlayOpen || !(s.phase === 'wave' || s.phase === 'intermission')) return;
    if (!s.paused) this.c.dispatch({ type: 'PAUSE' });
    this.open(
      'pause',
      `<h2>⏸ 일시정지</h2><p class="desc">전투·쿨다운·적 이동이 모두 멈췄어요.</p>
      <button class="btn" data-act="resume">계속하기 ▶</button>
      <button class="btn secondary" data-act="help">도움말</button>
      <button class="btn secondary" data-act="restart-same">처음부터 (같은 시드)</button>
      <div class="seed">seed ${s.seed} · tick ${s.tick}</div>`,
    );
  }

  private showResearch(refresh = false): void {
    const snapshot = this.c.getSnapshot();
    if (snapshot.phase === 'wave') {
      this.toast('🔬 연구 기록은 웨이브 사이에 확인할 수 있어요');
      return;
    }
    const academic = readAcademic();
    const gacha = readGachaOverview();
    const rows = MAJORS.map(m => {
      const t = academic.tracks[m];
      const xpText = t.level === 30 ? '최종 단계' : t.xp + ' / ' + xpToNext(t.level) + ' XP';
      const choose = t.level >= 27 && !t.branch
        ? '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn secondary" data-act="choose-branch" data-major="' + m + '" data-branch="research">연구 경로</button><button class="btn secondary" data-act="choose-branch" data-major="' + m + '" data-branch="operations">운영 경로</button></div>'
        : '';
      return '<div class="research-track"><strong>' + R0_RULES.majors[m].label + ' · 학사 Lv.' + t.level + '</strong><small>' + academicTitle(t) + ' · ' + xpText + '</small>' + choose + '</div>';
    }).join('');
    const growthMode = !!snapshot.growth;
    this.open('research',
      '<h2>🔬 전공 성장 · 가챠 연동</h2>' +
      (growthMode
        ? this.workshopHtml(snapshot) +
          '<a class="research-link secondary-link" href="' + modeUrl(false) + '">R0 기본 모드로 새 게임</a>'
        : '<p class="desc">현재 실증 범위: 같은 브라우저의 가챠 보유 데이터 조회와 전공별 학사 XP 기록. 장비 전투 적용·고유 특성은 R1 성장 시험 모드에서 쓸 수 있어요. 연구 카드는 아직 연결되지 않았어요.</p>' +
          '<a class="research-link" href="' + modeUrl(true) + '">🧰 R1 성장 시험 모드(장비·특성)로 새 게임</a>') +
      '<div class="help">가챠 저장 데이터: <b>' + (gacha.linked ? '연결됨 (로컬 데모)' : '아직 없음') + '</b><br>' +
      '보유 장비 설계도 <b>' + gacha.equipmentIds.length + '종</b> · 스킨 <b>' + gacha.skinIds.length + '종</b><br>' +
      '인덕코인 <b>' + gacha.ic + ' IC</b> · 연구칩 <b>' + gacha.rc + ' RC</b></div>' +
      '<a class="research-link" href="/gacha.html" target="_blank" rel="noopener noreferrer">🎰 가챠 연구소 v0.4.1 열기 ↗</a>' +
      '<p class="desc">가챠 연구소를 연 뒤 돌아와 연구 버튼을 다시 누르면 보유량이 갱신됩니다. 전투 승리 시 최종 배치된 전공마다 시험 XP 25가 기록됩니다.</p>' +
      rows + '<button class="btn" data-act="resume">게임으로 돌아가기</button>',
      refresh,
    );
  }

  /** R1-B equipment workshop: craft owned blueprints with battle coins, equip the selected unit. */
  private workshopHtml(s: RenderSnapshot): string {
    const g = s.growth!;
    const selected = s.units.find((u) => u.id === s.selectedUnitId);
    const bp = g.blueprints.length
      ? g.blueprints
          .map((id) => {
            const def = getEquipment(id)!;
            const who = def.major === 'shared' ? '공용' : R0_RULES.majors[def.major].label;
            const action = def.mods
              ? '<button class="mini" data-act="craft" data-bp="' + def.id + '"' + (s.coin < CRAFT_COST[def.rarity] ? ' disabled' : '') + '>제작 🪙' + CRAFT_COST[def.rarity] + '</button>'
              : '<span class="na">사용불가 · 미구현(' + UNSUPPORTED_LABEL[def.unsupported!] + ')</span>';
            return '<div class="gear-row' + (def.mods ? '' : ' off') + '"><span>' + def.emoji + ' <b>' + esc(def.name) + '</b><small>' + who + ' · ' + esc(def.desc) + '</small></span>' + action + '</div>';
          })
          .join('')
      : '<p class="desc">보유 설계도가 없어요. 가챠 연구소에서 장비 설계도를 뽑은 뒤 이 모드로 새 게임을 시작하세요.</p>';
    const unitBox = selected
      ? (() => {
          const gear = getEquipment(selected.equipment?.blueprintId);
          return '<div class="research-track"><strong>선택: ' + R0_RULES.majors[selected.major].label + ' ★' + selected.star + '</strong>' +
            '<small>특성 ' + traitText(getTrait(selected.trait)) + '</small>' +
            '<small>장비 ' + (gear ? gear.emoji + ' ' + esc(gear.name) : '없음 (1칸)') + ' · 공격 ' + fmt(selected.damage) + ' · 사거리 ' + fmt(selected.range) + '칸</small>' +
            (gear ? '<button class="mini" data-act="unequip" data-unit="' + selected.id + '">장비 해제</button>' : '') + '</div>';
        })()
      : '<p class="desc">보드에서 인덕이를 탭해 선택한 뒤 이 화면을 열면 장비를 장착할 수 있어요.</p>';
    const inv = g.inventory.length
      ? g.inventory
          .map((item) => {
            const def = getEquipment(item.blueprintId)!;
            const ok = !!selected && canEquip(def, selected.major);
            return '<div class="gear-row"><span>' + def.emoji + ' <b>' + esc(def.name) + '</b><small>' + esc(def.desc) + '</small></span>' +
              '<button class="mini" data-act="equip" data-item="' + item.id + '"' + (ok ? '' : ' disabled') + '>장착</button></div>';
          })
          .join('')
      : '<p class="desc">제작한 장비가 여기에 보관돼요.</p>';
    return '<div class="help"><b>🧰 장비 공방 · R1-B 시험 모드</b><br>런 시작 때 고정한 로컬 데모 설계도로 판 안에서 장비를 제작해요. 전투 코인만 쓰며 IC·RC는 바뀌지 않아요. 수치는 시험값이에요.</div>' +
      '<h3 class="sub">보유 설계도</h3>' + bp +
      '<h3 class="sub">장착</h3>' + unitBox +
      '<h3 class="sub">보관함</h3>' + inv;
  }

  /** Opened by the scene when the core rejected a merge with CHOICE_REQUIRED (nothing changed yet). */
  showMergeChoice(unitId: string, to: Point): void {
    const s = this.c.getSnapshot();
    const source = s.units.find((u) => u.id === unitId);
    const target = s.units.find((u) => u.cell.x === to.x && u.cell.y === to.y);
    if (!source || !target || this.overlayOpen) return;
    if (!s.paused && (s.phase === 'wave' || s.phase === 'intermission')) this.c.dispatch({ type: 'PAUSE' });
    this.pendingMerge = { unitId, to: { ...to } };
    const st = getTrait(source.trait);
    const tt = getTrait(target.trait);
    this.open(
      'merge',
      `<h2>✨ 합성 · 특성 계승</h2>
      <p class="desc">${R0_RULES.majors[target.major].label} ★${target.star} 두 명의 고유 특성이 달라요. 합성 결과에 남길 특성을 하나 고르세요. 결과 유닛의 장비는 그대로, 재료 유닛의 장비는 보관함으로 돌아가요.</p>
      <button class="btn secondary" data-act="merge-inherit" data-inherit="target">자리 유닛 특성 유지 · ${traitText(tt)}</button>
      <button class="btn secondary" data-act="merge-inherit" data-inherit="source">옮긴 유닛 특성 계승 · ${traitText(st)}</button>
      <button class="btn" data-act="merge-cancel">합성 취소 (아무것도 바뀌지 않아요)</button>`,
    );
  }

  private showHelp(): void {
    const s = this.c.getSnapshot();
    if (!s.paused && (s.phase === 'wave' || s.phase === 'intermission')) this.c.dispatch({ type: 'PAUSE' });
    const rows = MAJORS.map((m) => {
      const r = R0_RULES.majors[m];
      return `<b>${r.label}</b> — ${r.role}<br><span class="desc">사거리 ${r.range}칸 · 공격력 ${r.damage} · ${r.attackMs / 1000}초마다</span>`;
    }).join('<br>');
    this.open(
      'help',
      `<h2>📖 게임 안내</h2>
      <div class="help">${rows}</div>
      <p class="desc">합성하면 ★이 올라 공격력이 강해져요 (★당 +55%, 최대 ★4). 처치 +${R0_RULES.killReward}🪙, 웨이브 방어 +${R0_RULES.waveClearBonus}🪙. 유닛을 탭하면 사거리가 보이고, 다른 칸을 탭해도 이동·합성·교환할 수 있어요.</p>
      <button class="btn" data-act="resume">닫기</button>`,
    );
  }

  private showMajor(m: Major): void {
    const s = this.c.getSnapshot();
    if (!s.paused && (s.phase === 'wave' || s.phase === 'intermission')) this.c.dispatch({ type: 'PAUSE' });
    const r = R0_RULES.majors[m];
    const dmg = [1, 2, 3, 4].map((st) => Math.round(r.damage * (1 + R0_RULES.starDamageStep * (st - 1)))).join(' / ');
    this.open(
      'major',
      `<h2>${r.label}</h2><p>${r.role}</p>
      <div class="stat-row"><div>사거리<b>${r.range}칸</b></div><div>공격력<b>${r.damage}</b></div><div>공격 주기<b>${r.attackMs / 1000}초</b></div></div>
      <p class="desc">★1~★4 공격력: ${dmg}</p>
      <button class="btn" data-act="resume">닫기</button>`,
    );
  }

  private showEnd(won: boolean, s: RenderSnapshot): void {
    this.open(
      'end',
      `<h2>${won ? '🏆 중앙광장 방어 성공!' : '💔 본부 함락'}</h2>
      <p>${won ? '인덕이들이 모든 웨이브를 막아냈어요!' : `WAVE ${s.wave}에서 본부가 무너졌어요. 배치를 바꿔 다시 도전해 보세요.`}</p>
      <div class="stat-row"><div>웨이브<b>${s.wave}/${s.totalWaves}</b></div><div>처치<b>${s.kills}</b></div><div>본부 HP<b>${s.baseHp}</b></div></div>
      <button class="btn secondary" data-act="research">🔬 전공 성장·가챠 현황</button>
      <button class="btn" data-act="restart-new">새 게임 ↻</button>
      <button class="btn secondary" data-act="restart-same">같은 시드로 재도전</button>
      <div class="seed">seed ${s.seed} · tick ${s.tick}</div>`,
    );
  }

  private onModalClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    // Input-transition guard: ignore activations that arrive right after the overlay opened.
    if (performance.now() - this.overlayOpenedAt < 250) return;
    const act = btn.dataset.act;
    if (act === 'start') {
      this.close();
      this.c.dispatch({ type: 'START_RUN' });
    } else if (act === 'resume') {
      this.close();
      if (this.c.getSnapshot().paused) this.c.dispatch({ type: 'RESUME' });
    } else if (act === 'help') {
      this.close();
      this.showHelp();
    } else if (act === 'research') {
      this.close();
      this.showResearch();
    } else if (act === 'craft' || act === 'equip' || act === 'unequip') {
      const r =
        act === 'craft'
          ? this.c.dispatch({ type: 'CRAFT_EQUIPMENT', blueprintId: btn.dataset.bp ?? '' })
          : act === 'equip'
            ? this.c.dispatch({ type: 'EQUIP', unitId: this.c.getSnapshot().selectedUnitId ?? '', itemId: btn.dataset.item ?? '' })
            : this.c.dispatch({ type: 'UNEQUIP', unitId: btn.dataset.unit ?? '' });
      if (!r.accepted && r.reason) this.toast(REJECT_TEXT[r.reason]);
      else this.toast(act === 'craft' ? '🧰 장비를 제작했어요' : act === 'equip' ? '🧰 장비를 장착했어요' : '🧰 장비를 보관함에 넣었어요');
      this.showResearch(true);
    } else if (act === 'merge-inherit' || act === 'merge-cancel') {
      const pending = this.pendingMerge;
      this.pendingMerge = null;
      this.close();
      if (this.c.getSnapshot().paused) this.c.dispatch({ type: 'RESUME' });
      if (act === 'merge-inherit' && pending) {
        const inherit = btn.dataset.inherit === 'source' ? 'source' : 'target';
        const r = this.c.dispatch({ type: 'DROP_UNIT', unitId: pending.unitId, to: pending.to, inherit });
        if (!r.accepted && r.reason) this.toast(REJECT_TEXT[r.reason]);
      } else {
        this.toast('합성을 취소했어요');
      }
    } else if (act === 'choose-branch') {
      const major = btn.dataset.major as Major;
      const branch = btn.dataset.branch as 'research' | 'operations';
      if (chooseBranch(major, branch)) this.showResearch();
    } else if (act === 'restart-same' || act === 'restart-new') {
      const seed = act === 'restart-same' ? this.c.getSnapshot().seed : this.opts.newSeed();
      this.close();
      this.c.dispatch({ type: 'RESTART', seed });
      this.rewardOrdinal++;
      const url = new URL(location.href);
      url.searchParams.set('seed', String(seed));
      history.replaceState(null, '', url);
      this.showTitle();
    }
  }

  private renderMajors(): void {
    $('majors').innerHTML = MAJORS.map((m) => {
      const r = R0_RULES.majors[m];
      return `<button class="major-chip" type="button" data-major="${m}"><i style="background:${MAJOR_STYLE[m].css}">${MAJOR_STYLE[m].badge}</i>${MAJOR_STYLE[m].short}<small>${r.range}칸·${r.damage}</small></button>`;
    }).join('');
  }
}
