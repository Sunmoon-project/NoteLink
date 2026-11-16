import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { SummaryPatchDto } from '../src/modules/content/materials/dto/update-material.dto.js';
import {
  sectionsFromChunks,
  sectionsFromSlides,
} from '../src/modules/content/materials/material-sync.js';
import { fitSections, TRUNCATED_NOTICE } from '../src/modules/content/materials/summary-fit.js';
import {
  SUMMARY_BODY_MAX,
  SUMMARY_HEADING_MAX,
  SUMMARY_MAX_SECTIONS,
} from '../src/modules/content/materials/summary-limits.js';

type Section = { heading: string; body: string };

const within = (sections: Section[]) => {
  expect(sections.length).toBeLessThanOrEqual(SUMMARY_MAX_SECTIONS);
  for (const s of sections) {
    expect(s.heading.length).toBeGreaterThan(0);
    expect(s.heading.length).toBeLessThanOrEqual(SUMMARY_HEADING_MAX);
    expect(s.body.length).toBeLessThanOrEqual(SUMMARY_BODY_MAX);
  }
  expect(new Set(sections.map((s) => s.heading)).size).toBe(sections.length);
};
/** 편집 저장 검증(PATCH 의 SummaryPatchDto)을 그대로 통과하는지 */
const passesPatchValidation = (sections: Section[]) =>
  validateSync(plainToInstance(SummaryPatchDto, { sections }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
const chunk = (title: string | null, text: string, order: number) => ({
  title,
  text,
  order,
});
const count = (sections: Section[], ch: string) =>
  sections.reduce((n, s) => n + [...s.body].filter((c) => c === ch).length, 0);

describe('자동 요약을 편집 저장 상한 안으로 (FR-19)', () => {
  it('상한 값은 편집 저장 검증과 같은 곳에서 온다', () => {
    expect([SUMMARY_MAX_SECTIONS, SUMMARY_HEADING_MAX, SUMMARY_BODY_MAX]).toEqual([50, 100, 10000]);
  });

  it('짧은 섹션 51개는 상한 안으로 다시 나뉘고 소제목 51개가 모두 heading 이나 본문에 남는다', () => {
    const chunks = Array.from({ length: 51 }, (_, i) => chunk(`제목 ${i}`, `본문 ${i}`, i));
    const { sections } = sectionsFromChunks(chunks);
    within(sections);
    const text = sections.map((s) => `${s.heading}\n${s.body}`).join('\n');
    for (let i = 0; i < 51; i += 1) {
      expect(text).toContain(`제목 ${i}`);
      expect(text).toContain(`본문 ${i}`);
    }
    // 합쳐진 뒤 섹션의 소제목은 본문 안에 "■ 소제목" 한 줄로 남는다
    expect(sections[0]!.heading).toBe('제목 0');
    expect(sections[0]!.body).toContain('■ 제목 50\n본문 50');
    expect(passesPatchValidation(sections)).toEqual([]);
  });

  it('120자 제목은 100자로 자르고, 전체 제목은 본문 첫 줄에 남는다', () => {
    const title = '가'.repeat(120);
    const { sections } = sectionsFromChunks([chunk(title, '본문', 0)]);
    within(sections);
    expect(sections[0]!.heading).toBe('가'.repeat(100));
    expect(sections[0]!.body).toBe(`${title}\n본문`);
    expect(passesPatchValidation(sections)).toEqual([]);
  });

  it('앞 100자가 같은 긴 제목 둘도 제목이 겹치지 않는다', () => {
    const base = '나'.repeat(100);
    const { sections } = sectionsFromChunks([
      chunk(`${base}A`, '하나', 0),
      chunk(`${base}B`, '둘', 1),
    ]);
    within(sections);
    expect(sections).toHaveLength(2);
    expect(sections[1]!.heading).toMatch(/ \(2\)$/);
  });

  it('25,000자 본문은 같은 제목의 다음 섹션으로 나뉘고 글자는 하나도 줄지 않는다', () => {
    const { sections } = sectionsFromChunks([chunk('긴 글', 'x'.repeat(25_000), 0)]);
    within(sections);
    expect(sections.map((s) => s.heading)).toEqual(['긴 글', '긴 글 (2)', '긴 글 (3)']);
    expect(count(sections, 'x')).toBe(25_000);
    expect(passesPatchValidation(sections)).toEqual([]);
  });

  it('나뉜 섹션의 제목이 뒤에 있는 같은 이름 제목과 겹치지 않는다', () => {
    const { sections } = sectionsFromChunks([
      chunk('A', 'y'.repeat(12_000), 0),
      chunk('A', '다음', 1), // uniqueHeading 이 "A (2)" 로 만든 제목
    ]);
    within(sections);
    expect(sections.map((s) => s.heading)).toEqual(['A', 'A (3)', 'A (2)']);
    expect(count(sections, 'y')).toBe(12_000);
  });

  it('줄바꿈이 있으면 거기서 나누고, 서로게이트 쌍은 가르지 않는다', () => {
    const line = `${'가'.repeat(5999)}\n`;
    const split = fitSections([{ heading: 't', body: line.repeat(3) }]);
    within(split);
    expect(split.map((s) => s.body).join('')).toBe(line.repeat(3));
    expect(split[0]!.body.endsWith('\n')).toBe(true);
    const emoji = fitSections([{ heading: 'e', body: `${'a'.repeat(SUMMARY_BODY_MAX - 1)}😀끝` }]);
    within(emoji);
    expect(emoji.map((s) => s.body).join('')).toBe(`${'a'.repeat(SUMMARY_BODY_MAX - 1)}😀끝`);
    for (const s of emoji) expect(/[\ud800-\udbff]$/.test(s.body)).toBe(false);
  });

  it('섹션 51개 · 120자 제목 · 25,000자 본문이 함께 있어도 상한 안이고 내용은 줄지 않는다', () => {
    const chunks = [
      chunk('가'.repeat(120), 'z'.repeat(25_000), 0),
      ...Array.from({ length: 50 }, (_, i) => chunk(`제목 ${i}`, `짧은 글 ${i}`, i + 1)),
    ];
    const { sections } = sectionsFromChunks(chunks);
    within(sections);
    expect(count(sections, 'z')).toBe(25_000);
    const text = sections.map((s) => `${s.heading}\n${s.body}`).join('\n');
    expect(text).toContain('가'.repeat(120));
    for (let i = 0; i < 50; i += 1) expect(text).toContain(`짧은 글 ${i}`);
    expect(passesPatchValidation(sections)).toEqual([]);
  });

  it('6,000자 섹션 60개(36만 자)도 글자를 하나도 잃지 않고 50개 이하로 다시 나눈다', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      heading: `큰 ${i}`,
      body: 'w'.repeat(6000),
    }));
    const out = fitSections(big);
    within(out);
    expect(count(out, 'w')).toBe(360_000);
    expect(out.some((s) => s.body.endsWith(TRUNCATED_NOTICE))).toBe(false);
    const text = out.map((s) => `${s.heading}\n${s.body}`).join('\n');
    for (let i = 0; i < 60; i += 1) expect(text).toContain(`큰 ${i}`);
    expect(passesPatchValidation(out)).toEqual([]);
  });

  it('긴 본문 사이에 줄바꿈이 있어도 글자를 잃지 않는다', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      heading: `줄 ${i}`,
      body: `${'가'.repeat(4000)}\n${'나'.repeat(3900)}`,
    }));
    const out = fitSections(lines);
    within(out);
    expect(count(out, '가')).toBe(240_000);
    expect(count(out, '나')).toBe(234_000);
  });

  it('본문 합계가 50만 자를 넘을 때만 마지막 섹션을 상한에서 끊고 안내를 붙인다', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      heading: `큰 ${i}`,
      body: 'w'.repeat(9000),
    }));
    const out = fitSections(big);
    within(out);
    expect(out).toHaveLength(50);
    expect(out[49]!.body.endsWith(TRUNCATED_NOTICE)).toBe(true);
    expect(out[49]!.body.length).toBeLessThanOrEqual(SUMMARY_BODY_MAX);
    expect(out.slice(0, 49).every((s) => s.body === 'w'.repeat(9000))).toBe(true);
    expect(passesPatchValidation(out)).toEqual([]);
  });

  it('녹음 요약(슬라이드)에도 같은 상한을 적용한다', () => {
    const slides = [
      ...Array.from({ length: 60 }, (_, i) => ({ title: `슬라이드 ${i}`, summary: `내용 ${i}` })),
      { title: '나'.repeat(150), summary: 'q'.repeat(15_000) },
    ];
    const sections = sectionsFromSlides(slides);
    within(sections);
    expect(count(sections, 'q')).toBe(15_000);
    expect(passesPatchValidation(sections)).toEqual([]);
  });

  it('상한 안이면 그대로 둔다(기존 결과 유지)', () => {
    const input = [
      { heading: '하나', body: '본문 하나' },
      { heading: '둘', body: '본문 둘' },
    ];
    expect(fitSections(input)).toEqual(input);
  });
});
