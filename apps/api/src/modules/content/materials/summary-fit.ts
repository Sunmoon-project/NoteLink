import { SUMMARY_BODY_MAX, SUMMARY_HEADING_MAX, SUMMARY_MAX_SECTIONS } from './summary-limits.js';

export interface Section {
  heading: string;
  body: string;
}

/** 섹션이 너무 많고 합칠 수도 없을 때(본문 합계가 섹션 수 상한 × 본문 상한을 넘음) 마지막 섹션 끝에 붙이는 안내 */
export const TRUNCATED_NOTICE = '\n(내용이 길어 여기까지만 담았어요)';

/** 글자 수 at 에서 자르되 서로게이트 쌍의 가운데는 피한다 */
function safeCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at;
  const before = text.charCodeAt(at - 1);
  return before >= 0xd800 && before <= 0xdbff ? at - 1 : at;
}

/** 본문을 max 자 이하 조각으로 나눈다(이어 붙이면 원문 그대로). 줄바꿈이 절반 뒤에 있으면 거기서, 없으면 max 에서 자른다 */
function splitBody(body: string, max: number): string[] {
  const parts: string[] = [];
  let rest = body;
  while (rest.length > max) {
    const newline = rest.lastIndexOf('\n', max - 1) + 1;
    const cut = newline > max / 2 ? newline : safeCut(rest, max);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/** base 에 " (n)" 을 붙여 제목 상한 안에서 used 와 reserved 에 없는 이름을 만든다 */
function numbered(base: string, taken: (name: string) => boolean): string {
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const name = base.slice(0, safeCut(base, SUMMARY_HEADING_MAX - suffix.length)) + suffix;
    if (!taken(name)) return name;
  }
}

/** 100자 넘는 제목은 100자로 자르고 전체 제목을 본문 첫 줄에 남긴다 */
function limitHeading(section: Section): Section {
  if (section.heading.length <= SUMMARY_HEADING_MAX) return section;
  return {
    heading: section.heading.slice(0, safeCut(section.heading, SUMMARY_HEADING_MAX)),
    body: `${section.heading}\n${section.body}`,
  };
}

/** 본문이 상한을 넘으면 같은 제목의 다음 섹션("제목 (2)")으로 나눈다. 제목은 서로 겹치지 않게 한다(앱이 제목을 목록 키로 쓴다) */
function splitSections(sections: Section[]): Section[] {
  const limited = sections.map(limitHeading);
  const reserved = new Set(limited.map((s) => s.heading));
  const used = new Set<string>();
  const taken = (name: string) => used.has(name) || reserved.has(name);
  const out: Section[] = [];
  for (const section of limited) {
    const [first, ...more] = splitBody(section.body, SUMMARY_BODY_MAX);
    const heading = used.has(section.heading) ? numbered(section.heading, taken) : section.heading;
    used.add(heading);
    out.push({ heading, body: first! });
    for (const body of more) {
      const next = numbered(section.heading, taken);
      used.add(next);
      out.push({ heading: next, body });
    }
  }
  return out;
}

/**
 * 섹션이 상한을 넘으면 뒤쪽부터 이웃 섹션과 합친다(제목은 앞 섹션 것, 본문은 줄바꿈으로 이어 붙임).
 * 합친 본문이 상한을 넘는 쌍은 건너뛰고, 더 합칠 수 없을 때까지 뒤에서 앞으로 훑기를 반복한다.
 * 그래도 넘으면(본문 합계가 섹션 수 상한 × 본문 상한을 넘는 극단적인 경우) 마지막 섹션에 남은 내용을
 * 이어 붙이다가 상한에서 끊고 안내 문구를 붙인다 — 이 경우에만 내용이 줄어든다
 */
function mergeSections(sections: Section[]): Section[] {
  const out = sections.map((s) => ({ ...s }));
  for (let changed = true; changed && out.length > SUMMARY_MAX_SECTIONS;) {
    changed = false;
    for (let i = out.length - 1; i >= 1 && out.length > SUMMARY_MAX_SECTIONS; i -= 1) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      if (prev.body.length + 1 + cur.body.length <= SUMMARY_BODY_MAX) {
        prev.body = `${prev.body}\n${cur.body}`;
        out.splice(i, 1);
        changed = true;
      }
    }
  }
  if (out.length <= SUMMARY_MAX_SECTIONS) return out;
  const kept = out.slice(0, SUMMARY_MAX_SECTIONS - 1);
  const [head, ...tail] = out.slice(SUMMARY_MAX_SECTIONS - 1);
  const all = [head!.body, ...tail.map((s) => `${s.heading}\n${s.body}`)].join('\n');
  const room = SUMMARY_BODY_MAX - TRUNCATED_NOTICE.length;
  return [
    ...kept,
    { heading: head!.heading, body: all.slice(0, safeCut(all, room)) + TRUNCATED_NOTICE },
  ];
}

/** 자동 요약이 편집 저장 상한(섹션 50 · 제목 100자 · 본문 1만 자) 안에 들게 한다. 내용은 잃지 않는다(극단적인 경우 제외) */
export function fitSections(sections: Section[]): Section[] {
  return mergeSections(splitSections(sections));
}
