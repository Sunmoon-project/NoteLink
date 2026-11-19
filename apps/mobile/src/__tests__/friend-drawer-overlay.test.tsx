import { act, fireEvent, screen } from '@testing-library/react-native';
import { DRAWER_SCREEN, SocialDrawer } from '../features/social/drawer';
import { renderScreen } from '../test-utils';
import { MOTION } from '../theme';

const mockReduce = { value: false };
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => mockReduce.value,
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
afterEach(() => {
  mockReduce.value = false;
  jest.useRealTimers();
});

// 사용자 신고: 친구 창 왼쪽이 불투명한 회색으로 가려져 홈 화면이 보이지 않았다.
// 투명 모달을 화면 안의 <Stack.Screen options>로만 주면 iOS는 이미 일반(불투명) 화면으로 띄운 뒤라 바뀌지 않는다
// → 띄우기 전에 정해지도록 루트 스택에서 선언한다
it('친구 창(/friends)은 루트 스택에서 투명 모달로 선언해 뒤의 홈이 막 너머로 보인다', () => {
  expect(DRAWER_SCREEN).toMatchObject({
    presentation: 'transparentModal',
    contentStyle: { backgroundColor: 'transparent' },
  });
  // 루트 레이아웃은 글꼴 · 스플래시까지 불러와 그리기 무거워, 선언만 원문에서 확인한다(jest rootDir = apps/mobile)
  const layout: string = jest.requireActual('fs').readFileSync('app/_layout.tsx', 'utf8');
  expect(layout).toMatch(/<Stack\.Screen\s+name="friends"\s+options=\{DRAWER_SCREEN\}/);
});

it('막을 누르면 드로어가 밀려 나간 뒤(MOTION.exit) 닫힌다', async () => {
  jest.useFakeTimers();
  const onClose = jest.fn();
  await renderScreen(<SocialDrawer open onClose={onClose} />);
  await fireEvent.press(screen.getByLabelText('닫기'));
  expect(onClose).not.toHaveBeenCalled();
  // 나가는 동안 친구 창 내용은 화면에서 빠진다(exiting 모션이 이어 그린다)
  expect(screen.queryByText(/친구 추가/)).toBeNull();
  await act(async () => jest.advanceTimersByTime(MOTION.exit));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('동작 줄이기를 켜면 기다리지 않고 바로 닫는다', async () => {
  mockReduce.value = true;
  const onClose = jest.fn();
  await renderScreen(<SocialDrawer open onClose={onClose} />);
  await fireEvent.press(screen.getByLabelText('닫기'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
