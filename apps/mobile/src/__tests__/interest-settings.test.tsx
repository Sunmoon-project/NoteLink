// 프로필 > 계정 정보 > 관심 분야 다시 고르기
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { User } from '@notelink/shared';
import { AccountScreen, InterestsScreen } from '../features/profile/settings';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

const mockApi = { me: { get: jest.fn(), update: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
const user = (interestCategoryIds: string[]) =>
  ({ _id: 'u1', nickname: '테스터', interestCategoryIds }) as unknown as User;

beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null });
});

it('계정 정보에 고른 관심 분야를 보이고, 누르면 고르는 화면을 연다', async () => {
  mockApi.me.get.mockResolvedValue(user(['수능', '코딩']));
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('수능 · 코딩'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/interests');
});

it('고르지 않았으면 "선택 안 함"', async () => {
  mockApi.me.get.mockResolvedValue(user([]));
  await renderScreen(<AccountScreen />);
  expect(await screen.findByText('선택 안 함')).toBeTruthy();
});

it('저장된 분야가 켜진 채로 열리고, 바꾸기 전에는 저장할 수 없다', async () => {
  mockApi.me.get.mockResolvedValue(user(['어학']));
  await renderScreen(<InterestsScreen />);
  expect(await screen.findByText('1개 골랐어요')).toBeTruthy();
  await fireEvent.press(screen.getByText('저장'));
  expect(mockApi.me.update).not.toHaveBeenCalled();
});

it('켜고 끈 결과를 저장하고 돌아간다(모두 꺼도 된다)', async () => {
  mockApi.me.get.mockResolvedValue(user(['어학']));
  mockApi.me.update.mockImplementation(async (p: { interestCategoryIds: string[] }) => user(p.interestCategoryIds));
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('어학'));
  expect(screen.getByText('고르지 않아도 괜찮아요')).toBeTruthy();
  await fireEvent.press(screen.getByText('자격증'));
  await fireEvent.press(screen.getByText('공무원'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() =>
    expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: ['자격증', '공무원'] }),
  );
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(useToast.getState().msg).toBe('관심 분야를 바꿨어요');
});

it('저장에 실패하면 화면에 남아 고른 것을 그대로 둔다', async () => {
  mockApi.me.get.mockResolvedValue(user([]));
  mockApi.me.update.mockRejectedValue(new Error('network'));
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('코딩'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() => expect(mockApi.me.update).toHaveBeenCalled());
  expect(router.back).not.toHaveBeenCalled();
  expect(screen.getByText('1개 골랐어요')).toBeTruthy();
});
