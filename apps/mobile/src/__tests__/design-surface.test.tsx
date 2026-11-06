import { render, screen } from '@testing-library/react-native';
import { Card, Chip, Input, Screen } from '../components/ui';

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useSegments: () => [] }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const chipClass = () => String(screen.getByRole('button').props.className);
/** 입력칸을 감싼 상자의 클래스 */
const inputBox = (placeholder: string) => {
  let n = screen.getByPlaceholderText(placeholder).parent;
  while (n && !String(n.props.className ?? '').includes('rounded-xl')) n = n.parent;
  return String(n?.props.className);
};

it('개편 전 화면은 이전처럼 크림 칩 · 테두리 입력이다', async () => {
  await render(
    <Screen>
      <Card>
        <Chip>과목</Chip>
        <Input placeholder="이름" />
      </Card>
    </Screen>,
  );
  expect(chipClass()).toContain('bg-cream');
  expect(inputBox('이름')).toContain('border-line');
});

it('캔버스 화면 위는 흰 칩, 흰 카드 안은 채움 칩이다', async () => {
  await render(
    <Screen canvas>
      <Chip>바깥</Chip>
      <Card>
        <Chip>안쪽</Chip>
        <Input placeholder="메모" />
      </Card>
    </Screen>,
  );
  const [outer, inner] = screen.getAllByRole('button').map((b) => String(b.props.className));
  expect(outer).toContain('bg-white');
  expect(inner).toContain('bg-fill');
  expect(inputBox('메모')).toContain('bg-fill');
  expect(inputBox('메모')).not.toContain('border-line');
});
