// 녹음 요약 슬라이드 도식(FR-23): 5종을 그리고, 그릴 수 없는 값 · 없는 값은 그리지 않는다
import { render, screen } from '@testing-library/react-native';
import {
  RecordingDiagram,
  contrastRows,
  flowRows,
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
  expect(screen.getAllByText('정제')).toHaveLength(1);
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
  // 모이는 관계: 칩은 한 번만, 두 번째 줄은 이미 그린 결과를 흐린 글로 가리킨다
  expect(screen.getAllByText('가격 상승')).toHaveLength(2);
  expect(label()).toBe('도식(인과): 수요 증가, 그래서 가격 상승; 공급 감소, 그래서 가격 상승');
  expect(flowRows({ kind: 'cause', terms: ['a', 'b', 'c'], relations: [] })).toEqual([
    { terms: ['a', 'c'] },
    { terms: ['b'], to: 'c' },
  ]);
});

it('인과 · 순서 사슬: A→B, B→C 는 한 줄 「A → B → C」, 같은 칩은 한 번', async () => {
  await draw({
    kind: 'cause',
    terms: ['산소 부족', '젖산 축적', '근육 피로'],
    relations: [
      [0, 1],
      [1, 2],
    ],
  });
  expect(screen.getAllByText('젖산 축적')).toHaveLength(1);
  expect(label()).toBe('도식(인과): 산소 부족, 그래서 젖산 축적, 그래서 근육 피로');
  // 차례가 뒤섞인 관계도 사슬로 잇는다
  expect(
    flowRows({
      kind: 'sequence',
      terms: ['c', 'a', 'b'],
      relations: [
        [1, 2],
        [2, 0],
      ],
    }),
  ).toEqual([{ terms: ['a', 'b', 'c'] }]);
});

it('갈래: A→B, A→C 는 줄을 나누고 둘째 줄은 「A에서 → C」, 관계에 없는 핵심어도 빠뜨리지 않는다', () => {
  expect(
    flowRows({
      kind: 'cause',
      terms: ['a', 'b', 'c', 'd'],
      relations: [
        [0, 1],
        [0, 2],
      ],
    }),
  ).toEqual([{ terms: ['a', 'b'] }, { from: 'a', terms: ['c'] }, { terms: ['d'] }]);
  // 고리(a→b→a)도 끝난다
  expect(
    flowRows({
      kind: 'sequence',
      terms: ['a', 'b'],
      relations: [
        [0, 1],
        [1, 0],
      ],
    }),
  ).toEqual([{ terms: ['a', 'b'], to: 'a' }]);
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
  expect(label()).toBe('도식(인과): a, 그래서 b');
});
