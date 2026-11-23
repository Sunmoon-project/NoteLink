import { render, screen } from '@testing-library/react-native';
import { SummaryCard, summaryItemsMarkdown } from '../features/content/summary-format';
import { summaryMarkdown } from '../features/content/detail';

// FR-19: 위쪽 요약 칸은 양식대로, 양식 항목이 없는 옛 노트는 points 를 핵심 요약으로
const base = { sections: [{ heading: '해당과정', body: '포도당' }], points: ['옛 요약'] };

it('문답은 질문을 굵게 · 답을 아래에, 용어 정리는 용어와 뜻을 그린다', async () => {
  await render(
    <SummaryCard
      summary={{ ...base, format: 'qa', items: [{ head: '무엇이 나뉘나?', text: '포도당' }] }}
    />,
  );
  expect(screen.getByText('문답')).toBeTruthy();
  expect(screen.getByText('Q. 무엇이 나뉘나?')).toBeTruthy();
  expect(screen.getByText('포도당')).toBeTruthy();
  await render(
    <SummaryCard
      summary={{ ...base, format: 'terms', items: [{ head: 'ATP', text: '에너지' }] }}
    />,
  );
  expect(screen.getByText('용어 정리')).toBeTruthy();
  expect(screen.getByText('ATP')).toBeTruthy();
});

it('양식 항목이 없는 옛 노트는 points 를 핵심 요약으로 그린다', async () => {
  await render(<SummaryCard summary={base} />);
  expect(screen.getByText('핵심 요약')).toBeTruthy();
  expect(screen.getByText('• 옛 요약')).toBeTruthy();
});

it('한눈 요약은 제목만 바뀐 글머리 목록이고, 요약이 비면 칸을 그리지 않는다', async () => {
  await render(
    <SummaryCard summary={{ ...base, format: 'brief', items: [{ head: null, text: '세 줄' }] }} />,
  );
  expect(screen.getByText('한눈 요약')).toBeTruthy();
  const empty = await render(<SummaryCard summary={{ ...base, points: [] }} />);
  expect(empty.toJSON()).toBeNull();
});

it('마크다운 내보내기도 양식대로', async () => {
  expect(
    summaryItemsMarkdown({ ...base, format: 'terms', items: [{ head: 'ATP', text: '에너지' }] }),
  ).toBe('## 용어 정리\n\n- **ATP**: 에너지\n');
  const md = summaryMarkdown({
    title: '세포 호흡',
    keywords: [],
    summary: { ...base, format: 'qa', items: [{ head: '무엇이?', text: '포도당' }] },
  });
  expect(md).toContain('## 문답\n\n- **Q. 무엇이?**\n  포도당');
  expect(summaryMarkdown({ title: 't', keywords: [], summary: base })).toContain(
    '## 핵심 요약\n\n- 옛 요약',
  );
});
