import type { Material, NoteAskResult } from '@notelink/shared';

/** 노트를 부분(소제목 + 글)으로: 요약 → 핵심 → 쪽 글(OCR). 서버 note_ask의 노트 글 순서와 같다 */
function parts(m: Pick<Material, 'summary' | 'pages'>) {
  const out = (m.summary?.sections ?? []).map((s) => ({ heading: s.heading, body: s.body }));
  if (m.summary?.points.length) out.push({ heading: '핵심', body: m.summary.points.join(' ') });
  for (const p of m.pages ?? [])
    if (p.ocrText?.trim()) out.push({ heading: `${p.pageNo}쪽`, body: p.ocrText.trim() });
  return out;
}

/** 질문 낱말(2자 이상) */
const words = (q: string) => q.split(/[^0-9A-Za-z가-힣]+/).filter((w) => w.length >= 2);

/** 조사 · 어미가 붙어도 맞게 낱말 앞부분(끝 두 자까지 뗌)으로, 띄어쓰기는 무시하고 찾는다 */
function hit(text: string, w: string) {
  for (let n = w.length; n >= Math.max(2, w.length - 2); n--)
    if (text.includes(w.slice(0, n))) return true;
  return false;
}

// 서버(apps/ai note/ask.py)와 같은 안내 · 위험한 질문 검사(기기 저장 모드에서도 같은 규칙)
export const OFF_TOPIC =
  '그 질문은 학습 자료에 없어서 대답할 수 없어요. 이 노트나 퀴즈에 대해 물어봐 주세요.';
export const UNSAFE =
  '그 질문에는 대답할 수 없어요. 해킹이나 보안 공격처럼 위험한 내용은 도와드리지 않아요. 노트 내용으로 다시 물어봐 주세요.';
const UNSAFE_PATTERN = new RegExp(
  [
    '해킹|해커|크래킹|침투\\s*테스트|모의\\s*해킹|익스플로잇|exploit|취약점\\s*(공격|이용|찾)',
    '악성\\s*코드|멀웨어|malware|랜섬웨어|ransomware|트로이|바이러스\\s*(만들|제작|퍼뜨)',
    '피싱|phishing|스미싱|디도스|ddos|백도어|backdoor|키로거|keylogger|루트킷|rootkit',
    '(sql|에스큐엘)\\s*(인젝션|injection)|xss',
    '(비밀번호|패스워드|계정|인증)\\s*\\S{0,4}\\s*(뚫|탈취|훔치|훔쳐|크랙|우회|해제|도용|알아내)',
    '개인\\s*정보\\s*(빼|탈취|유출)|도청|스파이웨어',
    '탈옥|jailbreak|(이전|위|앞의?)\\s*지시\\S*\\s*무시|ignore\\s+(all|previous|the)|시스템\\s*프롬프트',
    '폭탄|폭발물|마약|무기\\s*(만들|제작)',
  ].join('|'),
  'i',
);
const refuse = (reason: 'off_topic' | 'unsafe'): NoteAskResult => ({
  answerable: false,
  reason,
  answer: reason === 'unsafe' ? UNSAFE : OFF_TOPIC,
  refs: [],
});

// 낱말이 하나도 안 겹쳐도 "핵심 알려 줘"처럼 노트 전체를 묻는 말뿐이면 첫 부분을 읽어 준다.
// "오늘 날씨 알려 줘"처럼 다른 낱말이 섞이면 자료 밖 질문으로 거절한다
// 낱말 전체가 "줄기 + 정해진 끝말"이어야 한다(해외여행 · 해물라면처럼 앞만 같은 낱말은 아님)
const OVERVIEW =
  /^(핵심|요약|정리|설명|뭐|무엇|무슨|알려|노트|자료|내용|전체|전부|이거|이것|그거|간단|좀|주세요|줘|해)(해|히|하게|해서)?(줘|주세요|줄래|줄래요|봐|봐요)?(야|이야|예요|에요|이에요|인가요|인지|요|은|는|을|를|이|가|의)?$/;
const overview = (ws: string[]) => ws.length > 0 && ws.every((w) => OVERVIEW.test(w));
const sentences = (t: string, n: number) =>
  (t.match(/[^.!?。]+[.!?。]?/g) ?? [t])
    .slice(0, n)
    .map((x) => x.trim())
    .join(' ');

/**
 * 기기 저장 모드의 아바타 답(서버 AI가 없을 때). 질문 낱말이 가장 많이 겹치는 부분을 읽어 준다.
 * 노트 글이 없으면 null(서버의 NOTE_NOT_READY와 같음)
 */
export function localAnswer(
  m: Pick<Material, 'summary' | 'pages'>,
  question: string,
): NoteAskResult | null {
  const all = parts(m);
  if (!all.length) return null;
  if (UNSAFE_PATTERN.test(question)) return refuse('unsafe');
  const ws = words(question);
  const scored = all.map((p) => {
    const text = `${p.heading}${p.body}`.replace(/\s+/g, '');
    return { p, score: ws.filter((w) => hit(text, w)).length };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (!best.score && !overview(ws)) return refuse('off_topic');
  const { heading, body } = best.score ? best.p : all[0]!;
  return {
    answerable: true,
    reason: null,
    answer: `노트의 '${heading}' 부분을 보면, ${sentences(body, 2)} 이어서 퀴즈로 확인해 볼까요?`,
    refs: [heading],
  };
}
