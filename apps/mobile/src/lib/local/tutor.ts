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
