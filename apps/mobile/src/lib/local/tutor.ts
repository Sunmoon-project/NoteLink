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

// 서버(apps/ai note/ask.py)와 같은 위험한 질문 검사 · 안내(기기 저장 모드에서도 같은 규칙)
export const UNSAFE =
  '그 질문에는 대답할 수 없어요. 해킹이나 보안 공격처럼 위험한 내용은 도와드리지 않아요. 노트 내용으로 다시 물어봐 주세요.';
const UNSAFE_PATTERN = new RegExp(
  [
    '해킹|해커|크래킹|침투\\s*테스트|모의\\s*해킹|익스플로잇|exploit|취약점\\s*(공격|이용|찾)',
    '악성\\s*코드|멀웨어|malware|랜섬웨어|ransomware|트로이\\s*(목마\\s*)?(바이러스|악성|프로그램|만들|만드|제작|퍼뜨|심)|트로이안|trojan\\s*(horse\\s*)?(virus|malware|바이러스|악성|프로그램|만들|만드|제작|퍼뜨|심)|바이러스\\s*(만들|만드|제작|퍼뜨)',
    '피싱|phishing|스미싱|디도스|ddos|백도어|backdoor|키로거|keylogger|루트킷|rootkit',
    '(sql|에스큐엘)\\s*(인젝션|injection)|xss',
    '(비밀번호|패스워드|계정|인증)\\s*\\S{0,4}\\s*(뚫|탈취|훔치|훔쳐|크랙|우회|해제|도용|알아내)',
    '개인\\s*정보\\s*(빼|탈취|유출)|도청|스파이웨어',
    '탈옥|jailbreak|(이전|위|앞의?)\\s*지시\\S*\\s*무시|ignore\\s+(all|previous|the)|시스템\\s*프롬프트',
    '폭탄|폭발물|마약|무기\\s*(만들|만드|제작)',
  ].join('|'),
  'i',
);

const OVERVIEW = /핵심|요약|정리|설명|뭐|무엇|알려/;
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
  // 위험한 질문은 노트에 그 낱말이 있어도 답하지 않는다
  if (UNSAFE_PATTERN.test(question))
    return { answerable: false, reason: 'unsafe', answer: UNSAFE, refs: [] };
  const ws = words(question);
  const scored = all.map((p) => {
    const text = `${p.heading}${p.body}`.replace(/\s+/g, '');
    return { p, score: ws.filter((w) => hit(text, w)).length };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  if (!best.score && !OVERVIEW.test(question))
    return {
      answerable: false,
      reason: 'off_topic',
      answer: '노트에는 없는 내용이에요. 서버에 연결되면 더 자세히 설명해 드릴게요.',
      refs: [],
    };
  const { heading, body } = best.score ? best.p : all[0]!;
  return {
    answerable: true,
    reason: null,
    answer: `노트의 '${heading}' 부분을 보면, ${sentences(body, 2)}`,
    refs: [heading],
  };
}
