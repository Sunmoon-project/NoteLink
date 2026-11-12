// 프로필 > 계정 정보 > 관심 분야 다시 고르기
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { User } from '@notelink/shared';
import { AccountScreen, InterestsScreen } from '../features/profile/settings';
import { QueryClient } from '@tanstack/react-query';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

const mockApi = { me: { get: jest.fn(), update: jest.fn(), interestCategories: jest.fn() } };
const ids = {
  자격증: '507f1f77bcf86cd799439001',
  수능: '507f1f77bcf86cd799439002',
  어학: '507f1f77bcf86cd799439003',
  전공: '507f1f77bcf86cd799439004',
  코딩: '507f1f77bcf86cd799439005',
  공무원: '507f1f77bcf86cd799439006',
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
const user = (interestCategoryIds: string[]) =>
  ({ _id: 'u1', nickname: '테스터', interestCategoryIds }) as unknown as User;

// 포커스 콜백을 모아 두고, 테스트에서 다른 탭으로 옮긴 것처럼 블러를 부른다
const mockFocus = new Set<() => (() => void) | void>();
jest.requireMock('expo-router').useFocusEffect = (cb: () => (() => void) | void) =>
  mockFocus.add(cb);
const blur = () => act(() => [...mockFocus].forEach((cb) => (cb() as () => void)()));

beforeEach(() => {
  jest.clearAllMocks();
  mockFocus.clear();
  mockApi.me.interestCategories.mockResolvedValue(
    Object.entries(ids).map(([name, _id]) => ({ _id, name, parentId: null })),
  );
  useToast.setState({ msg: null });
});

it('계정 정보에 고른 관심 분야를 보이고, 누르면 고르는 화면을 연다', async () => {
  mockApi.me.get.mockResolvedValue(user([ids.수능, ids.코딩]));
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
  mockApi.me.get.mockResolvedValue(user([ids.어학]));
  await renderScreen(<InterestsScreen />);
  expect(await screen.findByText('1개 골랐어요')).toBeTruthy();
  await fireEvent.press(screen.getByText('저장'));
  expect(mockApi.me.update).not.toHaveBeenCalled();
});

it('켜고 끈 결과를 저장하고 돌아간다(모두 꺼도 된다)', async () => {
  mockApi.me.get.mockResolvedValue(user([ids.어학]));
  mockApi.me.update.mockImplementation(async (p: { interestCategoryIds: string[] }) =>
    user(p.interestCategoryIds),
  );
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('어학'));
  expect(screen.getByText('고르지 않아도 괜찮아요')).toBeTruthy();
  await fireEvent.press(screen.getByText('자격증'));
  await fireEvent.press(screen.getByText('공무원'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() =>
    expect(mockApi.me.update).toHaveBeenCalledWith({
      interestCategoryIds: [ids.자격증, ids.공무원],
    }),
  );
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(useToast.getState().msg).toBe('관심 분야를 바꿨어요');
});

it('모두 끄고 저장하면 빈 목록을 보낸다', async () => {
  mockApi.me.get.mockResolvedValue(user([ids.어학, ids.코딩]));
  mockApi.me.update.mockResolvedValue(user([]));
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('어학'));
  await fireEvent.press(screen.getByText('코딩'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() => expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: [] }));
});

it('현재는 상위 분야만 선택하고 하위 분야는 새로 선택하지 않는다', async () => {
  const subId = '507f1f77bcf86cd799439007';
  mockApi.me.get.mockResolvedValue(user([]));
  mockApi.me.interestCategories.mockResolvedValue([
    { _id: ids.코딩, name: '코딩', parentId: null },
    { _id: subId, name: '기초', parentId: ids.코딩 },
    { _id: ids.어학, name: '어학', parentId: null },
    { _id: ids.수능, name: '기초', parentId: ids.어학 },
  ]);
  mockApi.me.update.mockImplementation(async (p: { interestCategoryIds: string[] }) =>
    user(p.interestCategoryIds),
  );
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('코딩'));
  expect(screen.queryByText('코딩 › 기초')).toBeNull();
  expect(screen.queryByText('어학 › 기초')).toBeNull();
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() =>
    expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: [ids.코딩] }),
  );
});

it('기존에 저장된 하위 분야는 자동으로 지우지 않고 제거를 안내한다', async () => {
  const subId = '507f1f77bcf86cd799439007';
  mockApi.me.get.mockResolvedValue(user([ids.코딩, subId]));
  mockApi.me.interestCategories.mockResolvedValue([
    { _id: ids.코딩, name: '코딩', parentId: null },
    { _id: subId, name: '기초', parentId: ids.코딩 },
  ]);
  mockApi.me.update.mockResolvedValue(user([ids.코딩]));
  await renderScreen(<InterestsScreen />);
  await fireEvent.press(await screen.findByText('코딩 › 기초 · 제거'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() =>
    expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: [ids.코딩] }),
  );
});

it('비활성이나 삭제된 기존 항목을 보여주고 제거한 후 저장할 수 있다', async () => {
  const missing = '507f1f77bcf86cd799439099';
  mockApi.me.get.mockResolvedValue(user([missing, ids.코딩]));
  mockApi.me.update.mockResolvedValue(user([ids.코딩]));
  await renderScreen(<InterestsScreen />);
  await screen.findByText('사용할 수 없는 분야 1 · 제거');
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  await fireEvent.press(screen.getByText('사용할 수 없는 분야 1 · 제거'));
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() =>
    expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: [ids.코딩] }),
  );
});

it('카테고리 조회 실패 시 저장을 막고 재시도할 수 있다', async () => {
  mockApi.me.get.mockResolvedValue(user([ids.어학]));
  mockApi.me.interestCategories
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue([{ _id: ids.어학, name: '어학', parentId: null }]);
  await renderScreen(<InterestsScreen />);
  expect(await screen.findByText('관심 분야를 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText('저장')).toBeNull();
  await fireEvent.press(screen.getByText('다시 시도'));
  expect(await screen.findByText('1개 골랐어요')).toBeTruthy();
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

it('내 정보를 못 읽으면 빈 목록 대신 안내하고, 다시 읽으면 저장된 분야로 연다', async () => {
  mockApi.me.get.mockRejectedValueOnce(new Error('network')).mockResolvedValue(user([ids.어학]));
  await renderScreen(<InterestsScreen />);
  expect(await screen.findByText('관심 분야를 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText('저장')).toBeNull();
  await fireEvent.press(screen.getByText('다시 시도'));
  expect(await screen.findByText('1개 골랐어요')).toBeTruthy();
});

describe('저장 응답이 늦게 올 때', () => {
  const later = () => {
    let done: (u: User) => void = () => {};
    mockApi.me.update.mockImplementation(() => new Promise<User>((r) => (done = r)));
    return (ids: string[]) => done(user(ids));
  };
  beforeEach(() => useAuth.setState({ userId: 'u1' }));

  it('화면을 떠났으면 한 번 더 뒤로 가지 않는다(내 정보는 고친다)', async () => {
    mockApi.me.get.mockResolvedValue(user([]));
    const finish = later();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = await renderScreen(<InterestsScreen />, qc);
    await fireEvent.press(await screen.findByText('코딩'));
    await fireEvent.press(screen.getByText('저장'));
    await waitFor(() => expect(mockApi.me.update).toHaveBeenCalled());
    await view.unmount();
    await act(async () => finish([ids.코딩]));
    expect(router.back).not.toHaveBeenCalled();
    expect(qc.getQueryData<User>(['me'])?.interestCategoryIds).toEqual([ids.코딩]);
  });

  it('다른 탭으로 옮겼으면 그 화면에서 뒤로 가지 않는다(내 정보는 고친다)', async () => {
    mockApi.me.get.mockResolvedValue(user([]));
    const finish = later();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderScreen(<InterestsScreen />, qc);
    await fireEvent.press(await screen.findByText('코딩'));
    await fireEvent.press(screen.getByText('저장'));
    await waitFor(() => expect(mockApi.me.update).toHaveBeenCalled());
    await blur();
    await act(async () => finish([ids.코딩]));
    expect(router.back).not.toHaveBeenCalled();
    expect(useToast.getState().msg).toBeNull();
    expect(qc.getQueryData<User>(['me'])?.interestCategoryIds).toEqual([ids.코딩]);
  });

  it('저장하는 동안에는 고른 것을 바꿀 수 없다', async () => {
    mockApi.me.get.mockResolvedValue(user([]));
    const finish = later();
    await renderScreen(<InterestsScreen />);
    await fireEvent.press(await screen.findByText('코딩'));
    await fireEvent.press(screen.getByText('저장'));
    // 요청은 잠금이 그려지기 전에 나갈 수 있다(CI에서 먼저 눌려 2개가 됐음): 잠긴 뒤에 누른다
    await waitFor(() => expect(screen.getByRole('button', { name: '어학' })).toBeDisabled());
    await fireEvent.press(screen.getByText('어학'));
    expect(screen.getByText('1개 골랐어요')).toBeTruthy();
    await act(async () => finish([ids.코딩]));
    expect(mockApi.me.update).toHaveBeenCalledWith({ interestCategoryIds: [ids.코딩] });
  });

  it('그사이 다른 계정으로 바뀌었으면 지금 계정의 내 정보에 넣지 않는다', async () => {
    mockApi.me.get.mockResolvedValue(user([]));
    const finish = later();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderScreen(<InterestsScreen />, qc);
    await fireEvent.press(await screen.findByText('코딩'));
    await fireEvent.press(screen.getByText('저장'));
    await waitFor(() => expect(mockApi.me.update).toHaveBeenCalled());
    const other = { ...user([ids.어학]), _id: 'u2' } as User;
    qc.setQueryData(['me'], other);
    useAuth.setState({ userId: 'u2' });
    await act(async () => finish([ids.코딩]));
    expect(qc.getQueryData(['me'])).toEqual(other);
    expect(router.back).not.toHaveBeenCalled();
  });
});
