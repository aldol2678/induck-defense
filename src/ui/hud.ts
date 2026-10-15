// DOM HUD: top stats, wave bar, action buttons and overlays. Reads snapshots, sends commands.
import type { GameController } from '../core/controller';
import { R0_RULES } from '../core/engine';
import type { DomainEvent, Major, RejectReason, RenderSnapshot } from '../core/types';
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
};

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

  private open(kind: string, html: string): void {
    this.overlayKind = kind;
    this.overlayOpenedAt = performance.now();
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
      <div class="seed">seed ${s.seed} · ruleset R0 · map plaza</div>`,
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

  private showResearch(): void {
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
    this.open('research',
      '<h2>🔬 전공 성장 · 가챠 연동</h2>' +
      '<p class="desc">현재 실증 범위: 같은 브라우저의 가챠 보유 데이터 조회와 전공별 학사 XP 기록. 장비 전투 적용·연구 카드 선택은 아직 연결되지 않았어요.</p>' +
      '<div class="help">가챠 저장 데이터: <b>' + (gacha.linked ? '연결됨 (로컬 데모)' : '아직 없음') + '</b><br>' +
      '보유 장비 설계도 <b>' + gacha.equipmentIds.length + '종</b> · 스킨 <b>' + gacha.skinIds.length + '종</b><br>' +
      '인덕코인 <b>' + gacha.ic + ' IC</b> · 연구칩 <b>' + gacha.rc + ' RC</b></div>' +
      '<a class="research-link" href="/gacha.html" target="_blank" rel="noopener noreferrer">🎰 가챠 연구소 v0.4.1 열기 ↗</a>' +
      '<p class="desc">가챠 연구소를 연 뒤 돌아와 연구 버튼을 다시 누르면 보유량이 갱신됩니다. 전투 승리 시 최종 배치된 전공마다 시험 XP 25가 기록됩니다.</p>' +
      rows + '<button class="btn" data-act="resume">게임으로 돌아가기</button>'
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
