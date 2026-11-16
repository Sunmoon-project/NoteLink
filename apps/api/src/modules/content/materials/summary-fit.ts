import { SUMMARY_BODY_MAX, SUMMARY_HEADING_MAX, SUMMARY_MAX_SECTIONS } from './summary-limits.js';

export interface Section {
  heading: string;
  body: string;
}

/** 섹션이 너무 많고 다시 나눌 수도 없을 때(본문 합계가 섹션 수 상한 × 본문 상한을 넘음) 마지막 섹션 끝에 붙이는 안내 */
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

/** 이어 붙는 섹션의 소제목을 본문 안에 남기는 줄 */
const headingLine = (heading: string) => `■ ${heading}\n`;

/**
 * 1단계: 섹션을 순서대로 덩어리에 채운다. 덩어리 첫 섹션의 제목은 덩어리 제목이고 본문에는 넣지 않는다.
 * 이어 붙는 섹션은 "■ 소제목" 줄 + 본문을 줄바꿈으로 붙이고, 남은 공간에 안 들어가면 새 덩어리를 시작한다.
 * (섹션 본문은 이미 splitSections 가 상한 이하로 나눴고 제목도 겹치지 않는다)
 */
function packGreedy(sections: Section[]): Section[] {
  const out: Section[] = [];
  for (const section of sections) {
    const last = out[out.length - 1];
    const addition = `\n${headingLine(section.heading)}${section.body}`;
    if (last && last.body.length + addition.length <= SUMMARY_BODY_MAX) last.body += addition;
    else out.push({ ...section });
  }
  return out;
}

/**
 * 2 · 3단계: 전체를 "첫 본문 + (줄바꿈 + 소제목 줄 + 본문)…" 흐름으로 이어 정확히 본문 상한 길이씩(서로게이트 쌍만 피해서)
 * 꽉 채워 자른다. 덩어리 제목은 그 덩어리가 시작하는 원래 섹션의 제목이다(같은 섹션에서 둘 이상 시작하면 번호를 붙인다).
 * 흐름이 섹션 수 상한 × 본문 상한 이하이면 글자를 잃지 않는다. 넘으면 마지막 덩어리를 안내 문구 자리만큼 줄여
 * 상한에서 끊고 안내 문구를 붙인다 — 이 경우에만 내용이 줄어든다
 */
function packFlow(sections: Section[]): Section[] {
  const starts: number[] = [];
  let flow = '';
  sections.forEach((section, i) => {
    starts.push(flow.length + (i === 0 ? 0 : 1)); // 섹션의 시작은 앞의 줄바꿈 다음(소제목 줄이 있는 자리)
    flow += (i === 0 ? '' : `\n${headingLine(section.heading)}`) + section.body;
  });
  const chunks: { start: number; text: string }[] = [];
  for (let offset = 0; offset < flow.length;) {
    const rest = flow.slice(offset);
    if (chunks.length === SUMMARY_MAX_SECTIONS - 1 && rest.length > SUMMARY_BODY_MAX) {
      const room = SUMMARY_BODY_MAX - TRUNCATED_NOTICE.length;
      chunks.push({ start: offset, text: rest.slice(0, safeCut(rest, room)) + TRUNCATED_NOTICE });
      break;
    }
    const text = rest.slice(0, safeCut(rest, Math.min(SUMMARY_BODY_MAX, rest.length)));
    chunks.push({ start: offset, text });
    offset += text.length;
  }
  const reserved = new Set(sections.map((s) => s.heading));
  const used = new Set<string>();
  const taken = (name: string) => used.has(name) || reserved.has(name);
  return chunks.map(({ start, text }) => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= start) index += 1;
    const base = sections[index]!.heading;
    const heading = used.has(base) ? numbered(base, taken) : base;
    used.add(heading);
    return { heading, body: text };
  });
}

/** 섹션이 상한을 넘으면 먼저 packGreedy 로 합치고, 그래도 50개를 넘으면 packFlow 로 꽉 채워 다시 나눈다 */
function mergeSections(sections: Section[]): Section[] {
  if (sections.length <= SUMMARY_MAX_SECTIONS) return sections;
  const greedy = packGreedy(sections);
  return greedy.length <= SUMMARY_MAX_SECTIONS ? greedy : packFlow(sections);
}

/** 자동 요약이 편집 저장 상한(섹션 50 · 제목 100자 · 본문 1만 자) 안에 들게 한다. 내용은 잃지 않는다(흐름이 50 × 1만 자를 넘는 극단적인 경우 제외) */
export function fitSections(sections: Section[]): Section[] {
  return mergeSections(splitSections(sections));
}
