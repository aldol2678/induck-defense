// Isolated local prototype. No server wallet writes or production account access.
import type { Major } from '../core/types';
export const GACHA_KEY = 'induck_gacha_demo_v01_20261015';
export const ACADEMIC_KEY = 'induck_defense_academic_v01';
export type AcademicTrack = { level: number; xp: number; branch: 'research'|'operations'|null };
export type AcademicProfile = { version: 1; tracks: Record<Major,AcademicTrack>; claims: string[] };
const majors: Major[] = ['engineering','sports','humanities'];
export function defaultProfile(): AcademicProfile {
  const track = ():AcademicTrack=>({level:1,xp:0,branch:null});
  return {version:1,tracks:{engineering:track(),sports:track(),humanities:track()},claims:[]};
}
const store = ():Storage|null=>{try{return typeof localStorage==='undefined'?null:localStorage}catch{return null}};
const safeInt=(x:unknown,cap:number):number => typeof x==='number'&&Number.isFinite(x)&&x>=0?Math.min(cap,Math.floor(x)):0;
export function xpToNext(level:number):number {return level>=30?0:35+Math.max(1,Math.floor(level))*15}
export function academicTitle(t: AcademicTrack):string {
  const lv=t.level;
  if(lv<=8)return '학부 '+Math.ceil(lv/2)+'학년 '+(lv%2===1?1:2)+'학기';
  if(lv<=12)return '석사 '+(lv-8)+'학기';
  if(lv<=18)return '박사 '+(lv-12)+'학기';
  if(lv<=20)return '박사후연구원 '+(lv===19?'초기':'숙련');
  if(lv<=22)return '조교수 '+(lv-20);
  if(lv<=24)return '부교수 '+(lv-22);
  if(lv<=26)return '정교수 '+(lv-24);
  const a=['석좌교수','선임석좌교수','대학석학','최고석학'];
  const b=['학과장','학장','부총장','총장'];
  return t.branch==null?'진로 선택 대기':(t.branch==='research'?a:b)[lv-27]||'최종 진로';
}
export function readAcademic(): AcademicProfile {
  const p=defaultProfile();
  try{
    const raw=store()?.getItem(ACADEMIC_KEY);
    if(!raw)return p;
    const v:unknown=JSON.parse(raw);
    if(!v||typeof v!=='object')return p;
    const x=v as Partial<AcademicProfile>;
    if(x.version!==1)return p;
    for(const m of majors){
      const g=x.tracks?.[m];
      if(!g)continue;
      const level=Math.max(1,safeInt(g.level,30));
      const xp=level===30?0:safeInt(g.xp,xpToNext(level)-1);
      const branch=g.branch==='research'||g.branch==='operations'?g.branch:null;
      p.tracks[m]={level,xp,branch};
    }
    p.claims=Array.isArray(x.claims)?x.claims.filter((s):s is string=>typeof s==='string'&&s.length<=120).slice(-100):[];
  }catch{/* malformed or unavailable local data */}
  return p;
}
function saveAcademic(p:AcademicProfile):boolean {
  try{const s=store();if(!s)return false;s.setItem(ACADEMIC_KEY,JSON.stringify(p));return true}catch{return false}
}
export function recordVictory(key:string,present:readonly Major[],xp=25): Major[] {
  if(!key||key.length>120||!Number.isInteger(xp)||xp<=0||xp>500)return [];
  const p=readAcademic();
  if(p.claims.includes(key))return [];
  const rewarded:Major[]=[];
  for(const m of [...new Set(present)]){
    if(!majors.includes(m))continue;
    const t=p.tracks[m];
    if(t.level>=30)continue;
    t.xp+=xp;
    while(t.level<30&&t.xp>=xpToNext(t.level)){t.xp-=xpToNext(t.level);t.level++}
    if(t.level===30)t.xp=0;
    rewarded.push(m);
  }
  p.claims.push(key);
  p.claims=p.claims.slice(-100);
  return saveAcademic(p)?rewarded:[];
}
export function chooseBranch(m:Major,branch:'research'|'operations'):boolean {
  if(!majors.includes(m))return false;
  const p=readAcademic();
  if(p.tracks[m].level<27||p.tracks[m].branch)return false;
  p.tracks[m].branch=branch;
  return saveAcademic(p);
}
export type GachaOverview = {linked:boolean; equipmentIds:string[]; skinIds:string[]; ic:number; rc:number};
export function readGachaOverview():GachaOverview {
  const e:GachaOverview={linked:false,equipmentIds:[],skinIds:[],ic:0,rc:0};
  try{
    const raw=store()?.getItem(GACHA_KEY);
    if(!raw)return e;
    const v=JSON.parse(raw) as {version?:unknown;owned?:unknown;ic?:unknown;rc?:unknown};
    if(v?.version!==1||!Array.isArray(v.owned))return e;
    const ids=[...new Set(v.owned.filter((x):x is string=>typeof x==='string'&&x.length<80))];
    return {linked:true,equipmentIds:ids.filter(x=>x.startsWith('eq-')),skinIds:ids.filter(x=>x.startsWith('skin-')),ic:safeInt(v.ic,1e9),rc:safeInt(v.rc,1e9)};
  }catch{return e}
}
