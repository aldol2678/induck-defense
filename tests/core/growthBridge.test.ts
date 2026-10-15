import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACADEMIC_KEY, GACHA_KEY, academicTitle, chooseBranch,
  defaultProfile, readAcademic, readGachaOverview, recordVictory, xpToNext,
} from '../../src/ui/growthBridge';

describe('GACHA-TO-R0 local demo integration bridge', () => {
  const values = new Map<string,string>();
  beforeEach(() => {
    values.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k:string) => values.get(k) ?? null,
        setItem: (k:string,v:string) => { values.set(k,v); },
        removeItem: (k:string) => { values.delete(k); },
        clear: () => { values.clear(); },
      },
    });
  });
  it('defaults to independent majors at academic level 1 without gacha inventory', () => {
    const p=readAcademic();
    expect(p.tracks.engineering.level).toBe(1);
    expect(p.tracks.sports.level).toBe(1);
    expect(p.tracks.humanities.level).toBe(1);
    expect(readGachaOverview().linked).toBe(false);
  });
  it('records victory XP exactly once per run and per participating major', () => {
    expect(recordVictory('run1',['engineering','engineering','sports'])).toEqual(['engineering','sports']);
    expect(recordVictory('run1',['engineering'])).toEqual([]);
    expect(readAcademic().tracks.engineering.xp).toBe(25);
    expect(readAcademic().tracks.sports.xp).toBe(25);
    expect(readAcademic().tracks.humanities.xp).toBe(0);
    recordVictory('run2',['engineering']);
    expect(readAcademic().tracks.engineering.level).toBe(2);
    expect(readAcademic().tracks.engineering.xp).toBe(0);
  });
  it('clamps corrupt local level and progress safely', () => {
    values.set(ACADEMIC_KEY, JSON.stringify({
      version:1, claims:[], tracks:{
        engineering:{level:900,xp:900,branch:'invalid'},
        sports:{level:27,xp:9999,branch:null},
        humanities:{level:-12,xp:-4,branch:null},
      },
    }));
    const p=readAcademic();
    expect(p.tracks.engineering).toEqual({level:30,xp:0,branch:null});
    expect(p.tracks.sports.xp).toBeLessThan(xpToNext(27));
    expect(p.tracks.humanities.level).toBe(1);
  });
  it('requires level 27 and prevents reselecting a branch', () => {
    expect(chooseBranch('engineering','research')).toBe(false);
    const p=defaultProfile();
    p.tracks.engineering.level=27;
    values.set(ACADEMIC_KEY,JSON.stringify(p));
    expect(chooseBranch('engineering','research')).toBe(true);
    expect(academicTitle(readAcademic().tracks.engineering)).toBe('석좌교수');
    expect(chooseBranch('engineering','operations')).toBe(false);
  });
  it('reads owned gacha demo items without modifying the source wallet', () => {
    const source={version:1,ic:170,rc:320,owned:['eq-eng-normal','eq-eng-normal','skin-campus','invalid','eq-xyz']};
    values.set(GACHA_KEY,JSON.stringify(source));
    const before=values.get(GACHA_KEY);
    expect(readGachaOverview()).toEqual({
      linked:true, equipmentIds:['eq-eng-normal','eq-xyz'],skinIds:['skin-campus'],ic:170,rc:320,
    });
    recordVictory('safe',['engineering']);
    expect(values.get(GACHA_KEY)).toBe(before);
  });
  it('rejects malformed gacha demo storage without crashing gameplay', () => {
    values.set(GACHA_KEY,'not JSON');
    expect(readGachaOverview().linked).toBe(false);
    values.set(ACADEMIC_KEY,'{');
    expect(readAcademic().tracks.engineering.level).toBe(1);
  });
});
