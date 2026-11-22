// 필기 도식(FR-19): 정리본 본문에서 after 줄 뒤에 녹음 도식 컴포넌트(밝은 색)로 그린다
import { render, screen } from '@testing-library/react-native';
import type { NoteDiagram } from '@notelink/shared';
import { NoteBody, placeDiagrams } from '../features/content/convert';

const d = (after: string | null, terms: string[] = ['해당과정', 'TCA 회로']): NoteDiagram => ({
  after,
  diagram: { kind: 'sequence', terms, relations: [[0, 1]] },
});

const SECTIONS = [
  { heading: '세포 호흡', body: '포도당 분해\n산소가 없으면 발효' },
  { heading: '정리', body: '# ATP\n- 전자전달계에서 생김' },
];

it('after 와 같은 줄 뒤에 둔다. null 은 첫 섹션 맨 앞, 못 찾으면 마지막 섹션 끝', () => {
  const a = d('포도당 분해');
  const top = d(null);
  const lost = d('지워진 줄');
  const marked = d('ATP'); // 편집기 표시(# · -)는 빼고 비교
  const placed = placeDiagrams(SECTIONS, [a, top, lost, marked]);
  expect(placed[0]!.before).toEqual([top.diagram]);
  expect(placed[0]!.after.get(0)).toEqual([a.diagram]);
  expect(placed[1]!.after.get(0)).toEqual([marked.diagram]);
  expect(placed[1]!.after.get(1)).toEqual([lost.diagram]);
});

it('같은 글의 줄이 둘이면 앞 도식 다음 줄부터 찾는다(차례 유지)', () => {
  const body = { heading: 'h', body: '반복\n가운데\n반복' };
  const placed = placeDiagrams([body], [d('가운데'), d('반복')]);
  expect([...placed[0]!.after.keys()]).toEqual([1, 2]);
});

it('도식이 없으면 그리지 않고, 있으면 그 줄 바로 뒤에 밝은 도식을 그린다', async () => {
  await render(<NoteBody sections={SECTIONS} />);
  expect(screen.queryByTestId('recording-diagram')).toBeNull();

  await render(<NoteBody sections={SECTIONS} diagrams={[d('포도당 분해')]} />);
  const drawn = screen.getByTestId('recording-diagram');
  expect(drawn.props.accessibilityLabel).toBe('도식(순서): 해당과정, 다음 TCA 회로');
  // 본문 첫 줄 · 도식 · 둘째 줄 차례
  const tree = JSON.stringify(screen.toJSON());
  const at = ['포도당 분해', '해당과정', '산소가 없으면 발효'].map((t) => tree.indexOf(t));
  expect(at.every((p) => p >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});
