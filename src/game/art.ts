// Placeholder art, drawn procedurally at runtime. These are original generic shapes,
// NOT the official Induck mascot or any Inha University asset (contract §7, SEC-01).
import Phaser from 'phaser';
import type { Major } from '../core/types';

export const TEX = 128;

export const MAJOR_STYLE: Record<Major, { body: number; accent: number; badge: string; short: string; css: string }> = {
  engineering: { body: 0xfff1c4, accent: 0xf2b630, badge: '공', short: '공대', css: '#f2b630' },
  sports: { body: 0xffe0d6, accent: 0xe5484d, badge: '체', short: '체대', css: '#ff7a7f' },
  humanities: { body: 0xe8e0fb, accent: 0x5b4bb7, badge: '문', short: '문과', css: '#a99cf0' },
};

export const ENEMY_STYLE: Record<string, { fill: number; edge: number; scale: number }> = {
  assignment: { fill: 0xf8f8ff, edge: 0x6c58b8, scale: 0.62 },
  quiz: { fill: 0xfff07a, edge: 0xc28a1c, scale: 0.5 },
  exam: { fill: 0xe06464, edge: 0x7c1f2e, scale: 0.78 },
};

function duck(g: Phaser.GameObjects.Graphics, major: Major): void {
  const s = MAJOR_STYLE[major];
  g.clear();
  g.fillStyle(0x2c4a63, 0.28).fillEllipse(64, 114, 78, 14);
  // feet
  g.fillStyle(0xf0a93a).lineStyle(3, 0xa6742d);
  g.fillEllipse(48, 108, 26, 10).strokeEllipse(48, 108, 26, 10);
  g.fillEllipse(80, 108, 26, 10).strokeEllipse(80, 108, 26, 10);
  // body + wings
  g.fillStyle(s.body).lineStyle(4, 0x6f6670);
  g.fillEllipse(64, 82, 82, 58).strokeEllipse(64, 82, 82, 58);
  g.fillEllipse(26, 84, 26, 34).strokeEllipse(26, 84, 26, 34);
  g.fillEllipse(102, 84, 26, 34).strokeEllipse(102, 84, 26, 34);
  // head
  g.fillCircle(64, 46, 31).strokeCircle(64, 46, 31);
  // eyes
  g.fillStyle(0x262c3c).fillEllipse(51, 45, 8, 11).fillEllipse(77, 45, 8, 11);
  g.fillStyle(0xffffff).fillCircle(52.5, 42, 2).fillCircle(78.5, 42, 2);
  // cheeks + beak
  g.fillStyle(0xff9fa8, 0.55).fillCircle(42, 56, 5).fillCircle(86, 56, 5);
  g.fillStyle(0xf5b64d).lineStyle(2.5, 0xbc883e);
  g.fillEllipse(64, 59, 24, 11).strokeEllipse(64, 59, 24, 11);
  // major outfit
  if (major === 'engineering') {
    // hard hat
    g.fillStyle(s.accent).lineStyle(3, 0x8c6418);
    g.beginPath();
    g.arc(64, 30, 27, Math.PI, 0, false);
    g.closePath();
    g.fillPath().strokePath();
    g.fillRect(30, 28, 68, 7).strokeRect(30, 28, 68, 7);
    g.fillStyle(0xffe08a).fillRect(60, 5, 8, 23);
    // wrench on belly
    g.lineStyle(5, 0x7f8c99).lineBetween(54, 92, 74, 76);
    g.fillStyle(0x7f8c99).fillCircle(76, 74, 6);
  } else if (major === 'sports') {
    // headband + whistle
    g.fillStyle(s.accent).lineStyle(2, 0x8c2228);
    g.fillRect(34, 26, 60, 9).strokeRect(34, 26, 60, 9);
    g.fillTriangle(94, 28, 108, 20, 106, 36);
    g.lineStyle(2, 0x3b4a5c).lineBetween(52, 66, 60, 84);
    g.fillStyle(0xc9d3dc).fillCircle(61, 86, 5);
    g.fillStyle(0xffffff).fillRect(54, 90, 22, 5);
  } else {
    // mortarboard + tassel + book
    g.fillStyle(s.accent).lineStyle(2, 0x2a2160);
    g.fillRect(44, 18, 40, 12).strokeRect(44, 18, 40, 12);
    g.beginPath();
    g.moveTo(26, 16);
    g.lineTo(64, 4);
    g.lineTo(102, 16);
    g.lineTo(64, 28);
    g.closePath();
    g.fillPath().strokePath();
    g.lineStyle(3, 0xf3c74a).lineBetween(64, 16, 96, 22).lineBetween(96, 22, 96, 38);
    g.fillStyle(0xf3c74a).fillCircle(96, 40, 4);
    g.fillStyle(0x4f7fd1).lineStyle(2, 0x2c4a86);
    g.fillRect(50, 80, 28, 20).strokeRect(50, 80, 28, 20);
    g.lineStyle(2, 0xffffff).lineBetween(64, 81, 64, 99);
  }
}

function enemy(g: Phaser.GameObjects.Graphics, kind: string): void {
  const st = ENEMY_STYLE[kind] ?? ENEMY_STYLE.assignment!;
  g.clear();
  g.fillStyle(0x24324a, 0.28).fillEllipse(64, 116, 70, 14);
  g.fillStyle(st.fill).lineStyle(5, st.edge);
  if (kind === 'exam') {
    // thick exam booklet
    g.fillRoundedRect(22, 18, 84, 92, 12).strokeRoundedRect(22, 18, 84, 92, 12);
    g.fillStyle(0xfdf1d6).fillRect(30, 26, 12, 76);
    g.lineStyle(4, 0x7c1f2e).lineBetween(54, 34, 94, 34);
  } else if (kind === 'quiz') {
    // sticky-note quiz
    g.fillRoundedRect(20, 24, 88, 84, 8).strokeRoundedRect(20, 24, 88, 84, 8);
    g.fillStyle(0xf3c64b).fillTriangle(108, 84, 108, 108, 84, 108);
  } else {
    // homework sheet with a folded corner
    g.beginPath();
    g.moveTo(26, 14);
    g.lineTo(84, 14);
    g.lineTo(104, 34);
    g.lineTo(104, 112);
    g.lineTo(26, 112);
    g.closePath();
    g.fillPath().strokePath();
    g.fillStyle(0xd9d4f3).fillTriangle(84, 14, 84, 34, 104, 34);
    g.lineStyle(3, 0xb6b0de).lineBetween(38, 92, 92, 92).lineBetween(38, 102, 80, 102);
  }
  // angry face
  g.fillStyle(0x262c3c).fillEllipse(50, 62, 11, 14).fillEllipse(78, 62, 11, 14);
  g.fillStyle(0xffffff).fillCircle(52, 58, 2.5).fillCircle(80, 58, 2.5);
  g.lineStyle(4, 0x262c3c).lineBetween(40, 46, 56, 52).lineBetween(88, 46, 72, 52);
  g.beginPath();
  g.arc(64, 86, 9, Math.PI * 1.15, Math.PI * 1.85, false);
  g.strokePath();
}

export function generateTextures(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  for (const m of Object.keys(MAJOR_STYLE) as Major[]) {
    duck(g, m);
    g.generateTexture(`duck-${m}`, TEX, TEX);
  }
  for (const k of Object.keys(ENEMY_STYLE)) {
    enemy(g, k);
    g.generateTexture(`enemy-${k}`, TEX, TEX);
  }
  g.clear();
  g.fillStyle(0xffffff).fillCircle(8, 8, 8);
  g.generateTexture('dot', 16, 16);
  g.destroy();
}
