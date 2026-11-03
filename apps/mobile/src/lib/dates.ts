// 날짜는 서울 기준으로 계산한다 (README: 하루는 자정에 바뀐다)
// 순간(시각)을 날짜로 바꿀 때는 seoul()을 거친다. 그 뒤의 달력 계산(ymd · addDays · parse)은
// 기기 시간대의 '벽시계 날짜'로만 하므로 기기 시간대와 상관없이 같은 결과가 나온다.

const pad = (n: number) => String(n).padStart(2, '0');

const SEOUL_OFFSET_MS = 9 * 3600 * 1000;
/** 그 순간의 서울 날짜 · 시각을 기기 시간대 Date로 (기본: 지금) */
// ponytail: 서울은 1988년 이후 서머타임이 없어 UTC+9 고정으로 계산한다. 다른 시간대를 쓰게 되면 Intl로 바꾼다
export const seoul = (t: Date | string | number = Date.now()) => {
  const u = new Date(new Date(t).getTime() + SEOUL_OFFSET_MS);
  return new Date(
    u.getUTCFullYear(),
    u.getUTCMonth(),
    u.getUTCDate(),
    u.getUTCHours(),
    u.getUTCMinutes(),
    u.getUTCSeconds(),
  );
};

export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(seoul());
export const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const parse = (s: string) => {
  const [y = 1970, m = 1, d = 1] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const WD = ['일', '월', '화', '수', '목', '금', '토'];
export const md = (s: string) => {
  const d = parse(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
};
export const daysBetween = (a: string, b: string) =>
  Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
export const dLabel = (daysLeft: number) =>
  daysLeft === 0 ? 'D-day' : daysLeft > 0 ? `D-${daysLeft}` : `D+${-daysLeft}`;

/** 00:00:00 */
export const hms = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
/** 14시간 22분 */
export const hm = (sec: number) =>
  `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
/** 지난주와 비교한 문구 (주간 요약의 diffFromLastWeekSec) */
export const diffLabel = (sec: number) => {
  if (Math.abs(sec) < 60) return '지난주와 비슷해요';
  const t = hm(Math.abs(sec)).replace(/^0시간 /, '');
  return sec > 0 ? `지난주보다 ${t} 늘었어요` : `지난주보다 ${t} 줄었어요`;
};
export const goalLabel = (min: number | null) =>
  !min ? '목표 없음' : min >= 60 ? `${min / 60}시간` : `${min}분`;
export const timeAgo = (iso: string) => {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return '방금';
  if (h < 24) return `${Math.floor(h)}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
};
export const clock = (iso: string) => {
  const d = seoul(iso);
  const isToday = ymd(d) === today();
  const yest = ymd(d) === ymd(addDays(seoul(), -1));
  return `${isToday ? '오늘' : yest ? '어제' : `${d.getMonth() + 1}월 ${d.getDate()}일`} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
