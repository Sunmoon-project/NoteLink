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

/** 합쳐 이어 붙인 섹션의 소제목을 본문 안에 남기는 줄 */
const headingLine = (heading: string) => `■ ${heading}
`;

/**
 * 본문 합계가 섹션 수 상한 × 본문 상한 이하일 때 글자를 잃지 않고 다시 나눈다. 섹션을 순서대로 "소제목 줄 + 본문"
 * 흐름으로 이어 놓고(첫 섹션은 본문만) 본문 상한 이하 덩어리로 다시 채운다. 덩어리의 제목은 그 덩어리가 시작하는 원래
 * 섹션의 제목이고(그 섹션의 시작에서 시작하면 소제목 줄은 제목이 대신하므로 뺀다), 줄바꿈 근처에서 자르며
 * 서로게이트 쌍은 가르지 않는다. 소제목 줄까지 더하면 섹션 수 상한에 담기지 않으면 null
 */
function repack(sections: Section[]): Section[] | null {
  const starts: number[] = [];
  let flow = '';
  sections.forEach((section, i) => {
    starts.push(flow.length);
    flow +=
      (i === 0 ? '' : headingLine(section.heading)) +
      section.body +
      (i === sections.length - 1 ? '' : '\n');
  });
  const chunks: { start: number; text: string }[] = [];
  let offset = 0;
  while (offset < flow.length) {
    const rest = flow.slice(offset);
    if (rest.length <= SUMMARY_BODY_MAX) {
      chunks.push({ start: offset, text: rest });
      break;
    }
    // 남은 덩어리 수 안에 나머지가 들어가도록 최소한 이만큼은 잘라야 한다
    const left = SUMMARY_MAX_SECTIONS - chunks.length - 1;
    const floor = Math.max(
      rest.length - left * SUMMARY_BODY_MAX,
      Math.floor(SUMMARY_BODY_MAX / 2) + 1,
    );
    const newline = rest.lastIndexOf('\n', SUMMARY_BODY_MAX - 1) + 1;
    const cut = newline >= floor ? newline : safeCut(rest, SUMMARY_BODY_MAX);
    chunks.push({ start: offset, text: rest.slice(0, cut) });
    offset += cut;
    if (chunks.length >= SUMMARY_MAX_SECTIONS && offset < flow.length) return null;
  }
  if (chunks.length > SUMMARY_MAX_SECTIONS) return null;
  const reserved = new Set(sections.map((s) => s.heading));
  const used = new Set<string>();
  const taken = (name: string) => used.has(name) || reserved.has(name);
  return chunks.map(({ start, text }) => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= start) index += 1;
    const base = sections[index]!.heading;
    const heading = used.has(base) ? numbered(base, taken) : base;
    used.add(heading);
    const marker = index > 0 && start === starts[index] ? headingLine(base) : '';
    const body = marker && text.length > marker.length ? text.slice(marker.length) : text;
    return { heading, body };
  });
}

/**
 * 섹션이 상한을 넘으면 본문 합계가 50만 자(섹션 수 상한 × 본문 상한) 이하일 때 repack 으로 글자 · 소제목을 잃지 않고
 * 다시 나눈다. 그보다 길면 마지막 섹션에 남은 내용을 이어 붙이다가 상한에서 끊고 안내 문구를 붙인다 — 이 경우에만
 * 내용이 줄어든다
 */
function mergeSections(sections: Section[]): Section[] {
  if (sections.length <= SUMMARY_MAX_SECTIONS) return sections;
  const total = sections.reduce((n, s) => n + s.body.length, 0);
  if (total <= SUMMARY_MAX_SECTIONS * SUMMARY_BODY_MAX) {
    const packed = repack(sections);
    if (packed) return packed;
  }
  const kept = sections.slice(0, SUMMARY_MAX_SECTIONS - 1).map((s) => ({ ...s }));
  const [head, ...tail] = sections.slice(SUMMARY_MAX_SECTIONS - 1);
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
