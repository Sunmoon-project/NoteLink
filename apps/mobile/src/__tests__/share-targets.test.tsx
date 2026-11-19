import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { ShareScreen, SharedScreen } from '../features/content/detail';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 공유 시트를 스터디룸 / 친구로 나누고, 서버가 아직 막는 친구 공유는 고르지 못하게 한다(FR-26-01, #554 PR 0)
const mockApi = {
  content: { material: jest.fn(), materials: jest.fn(), folders: jest.fn(), share: jest.fn() },
  rooms: { mine: jest.fn() },
  social: { friends: jest.fn() },
};
class MockApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  // 모듈을 읽을 때는 아직 클래스가 없어서 쓸 때 꺼낸다
  get ApiError() {
    return MockApiError;
  },
}));
const mockEnv = { localData: false, apiUrl: 'https://api.example' };
jest.mock('../lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));

const note = { _id: 'n1', folderId: 'f1', kind: 'handwriting', title: '미적분 필기' };

beforeEach(() => {
  jest.clearAllMocks();
  mockEnv.localData = false;
  setParams({ folderId: 'f1' });
  mockApi.content.materials.mockResolvedValue([note]);
  mockApi.content.folders.mockResolvedValue([{ _id: 'f1' }]);
  mockApi.content.share.mockResolvedValue(undefined);
  mockApi.rooms.mine.mockResolvedValue([{ _id: 'r1', title: '수능 국어방' }]);
  mockApi.social.friends.mockResolvedValue([{ userId: 'u2', nickname: '민지' }]);
});

const openSheet = async () => {
  await renderScreen(<ShareScreen />);
  await fireEvent.press(await screen.findByText('미적분 필기'));
  await fireEvent.press(screen.getByText(/공유 대상을 선택해주세요/));
};

it('대상 시트를 스터디룸 · 친구 칸으로 나누고 친구는 「곧 지원」이라 고를 수 없다', async () => {
  await openSheet();
  expect(await screen.findByText('스터디룸')).toBeTruthy();
  expect(screen.getByText('친구')).toBeTruthy();
  expect(await screen.findByText('민지')).toBeTruthy();
  expect(screen.getByText('곧 지원')).toBeTruthy();
  expect(screen.queryByText(/친구 · /)).toBeNull();
  const row = screen.getByLabelText('민지, 곧 지원');
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  await fireEvent.press(row);
  // 눌러도 대상이 정해지지 않아 공유하기를 눌러도 보내지 않는다(서버가 아직 친구 공유를 막는다)
  expect(screen.getByText(/공유 대상을 선택해주세요/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
  expect(mockApi.content.share).not.toHaveBeenCalled();
});

it('스터디룸으로 보내면 완료 화면에 스터디룸 이름이 간다', async () => {
  await openSheet();
  await fireEvent.press(await screen.findByText('수능 국어방'));
  await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
  await waitFor(() =>
    expect(mockApi.content.share).toHaveBeenCalledWith({
      materialIds: ['n1'],
      target: { type: 'room', id: 'r1' },
    }),
  );
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/note-shared',
    params: expect.objectContaining({ to: '수능 국어방' }),
  });
});

it('참여 중인 스터디룸이 없으면 빈 안내를 보여 준다', async () => {
  mockApi.rooms.mine.mockResolvedValue([]);
  await openSheet();
  expect(await screen.findByText('참여 중인 스터디룸이 없어요')).toBeTruthy();
});

it('서버 연결인데 친구가 없으면 빈 안내를 보여 준다', async () => {
  mockApi.social.friends.mockResolvedValue([]);
  await openSheet();
  expect(await screen.findByText('아직 친구가 없어요')).toBeTruthy();
});

// 실기기 피드백(2026-11-20): 친구 칸이 연결 문제처럼 읽혔다. 아직 열리지 않은 기능이라고만 말한다
it.each([false, true])('친구 칸은 「곧 열려요」로만 안내한다(기기 저장 모드 %s)', async (local) => {
  mockEnv.localData = local;
  await openSheet();
  expect(await screen.findByText('친구에게 보내기는 곧 열려요')).toBeTruthy();
  expect(screen.queryByText(/서버에 연결하면/)).toBeNull();
});

it.each([
  [
    '서버가 거절(4xx)하면 서버 문구',
    new MockApiError('NOT_FOUND', '스터디룸 정보를 찾을 수 없어요', 404),
    '스터디룸 정보를 찾을 수 없어요',
  ],
  [
    '연결 오류면 연결 문구',
    new Error('Network request failed'),
    '공유하지 못했어요. 연결을 확인하고 다시 시도해 주세요',
  ],
])('공유에 실패하면 %s를 띄운다', async (_name, error, message) => {
  mockApi.content.share.mockRejectedValue(error);
  await openSheet();
  await fireEvent.press(await screen.findByText('수능 국어방'));
  await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
  await waitFor(() => expect(useToast.getState().msg).toBe(message));
});

it('완료 화면은 「○○ 스터디룸에」로 말한다', async () => {
  setParams({ to: '수능 국어', n: '2', tab: '필기', name: '미적분 필기' });
  await renderScreen(<SharedScreen />);
  expect(screen.getByText('수능 국어 스터디룸에 필기 2개를 공유했어요')).toBeTruthy();
  expect(screen.getByText('수능 국어 스터디룸에 보냈어요')).toBeTruthy();
});

it('방 이름이 「방」으로 끝나면 「스터디룸」을 겹쳐 붙이지 않는다', async () => {
  setParams({ to: '수능 국어방', n: '1', tab: '필기' });
  await renderScreen(<SharedScreen />);
  expect(screen.getByText('수능 국어방에 필기 1개를 공유했어요')).toBeTruthy();
});

it('목록을 못 불러오면 빈 칸 대신 이유를 보여 준다', async () => {
  mockApi.rooms.mine.mockRejectedValue(new Error('x'));
  mockApi.social.friends.mockRejectedValue(new Error('x'));
  await openSheet();
  expect(await screen.findByText('스터디룸 목록을 불러오지 못했어요')).toBeTruthy();
  expect(await screen.findByText('친구 목록을 불러오지 못했어요')).toBeTruthy();
});
