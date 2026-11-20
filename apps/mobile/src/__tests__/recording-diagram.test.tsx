// 녹음 요약 슬라이드 도식(FR-23): 5종을 그리고, 그릴 수 없는 값 · 없는 값은 그리지 않는다
import { render, screen } from '@testing-library/react-native';
import {
  RecordingDiagram,
  causeGroups,
  contrastRows,
  hierarchyRows,
} from '../features/content/recording-diagram';

const draw = (diagram: unknown) => render(<RecordingDiagram diagram={diagram} />);
const label = () => screen.getByTestId('recording-diagram').props.accessibilityLabel as string;

it('순서: 핵심어를 차례로 그리고 내용을 글로 읽힌다', async () => {
  await draw({
    kind: 'sequence',
    terms: ['수집', '정제', '학습'],
    relations: [
      [0, 1],
      [1, 2],
    ],
  });
  for (const t of ['수집', '정제', '학습']) screen.getByText(t);
  expect(label()).toBe('도식(순서): 수집, 다음 정제, 다음 학습');
});

it('대비: 관계로 짝짓고, 관계가 없으면 반반', async () => {
  await draw({ kind: 'contrast', terms: ['TCP', 'UDP'], relations: [[0, 1]] });
  screen.getByText('vs');
  expect(label()).toBe('도식(대비): TCP 대 UDP');
  const d = { kind: 'contrast' as const, terms: ['a', 'b', 'c', 'd'], relations: [] };
  expect(contrastRows(d)).toEqual([
    ['a', 'c'],
    ['b', 'd'],
  ]);
  expect(contrastRows({ ...d, relations: [[0, 3]] })).toEqual([
    ['a', 'd'],
    ['b', 'c'],
  ]);
});

it('포함: 위 → 아래 나무, 고리가 있어도 모든 핵심어를 한 번씩', async () => {
  await draw({
    kind: 'hierarchy',
    terms: ['생물', '동물', '식물'],
    relations: [
      [0, 1],
      [0, 2],
    ],
  });
  expect(label()).toBe('도식(포함): 생물, 1단계 동물, 1단계 식물');
  expect(
    hierarchyRows({
      kind: 'hierarchy',
      terms: ['a', 'b', 'c'],
      relations: [
        [0, 1],
        [1, 0],
        [1, 2],
      ],
    }),
  ).toEqual([
    { term: 'a', depth: 0 },
    { term: 'b', depth: 1 },
    { term: 'c', depth: 2 },
  ]);
});

it('인과: 원인 → 결과, 관계가 없으면 마지막이 결과', async () => {
  await draw({
    kind: 'cause',
    terms: ['수요 증가', '공급 감소', '가격 상승'],
    relations: [
      [0, 2],
      [1, 2],
    ],
  });
  expect(label()).toBe('도식(인과): 수요 증가와 공급 감소 때문에 가격 상승');
  expect(causeGroups({ kind: 'cause', terms: ['a', 'b'], relations: [] })).toEqual([
    { causes: ['a'], effect: 'b' },
  ]);
});

it('나열: 점 붙은 항목 줄', async () => {
  await draw({ kind: 'list', terms: ['정의', '성질'], relations: [] });
  screen.getByText('정의');
  expect(label()).toBe('도식(나열): 정의, 성질');
});

it('없거나 그릴 수 없는 값은 아무것도 그리지 않는다', async () => {
  for (const bad of [
    null,
    undefined,
    { kind: 'venn', terms: ['a', 'b'], relations: [] },
    { kind: 'list', terms: [], relations: [] },
    { kind: 'list', terms: ['a', ''], relations: [] },
  ]) {
    await draw(bad);
    expect(screen.queryByTestId('recording-diagram')).toBeNull();
  }
});

it('범위 밖 관계는 그 관계만 무시한다', async () => {
  await draw({ kind: 'cause', terms: ['a', 'b'], relations: [[0, 7]] });
  expect(label()).toBe('도식(인과): a 때문에 b');
});
