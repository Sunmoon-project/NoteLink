// 알림함 · 알림 설정 · 채팅 음소거(#560)
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text } from 'react-native';
import {
  BellButton,
  InboxScreen,
  NotificationSettingsScreen,
  useChatMute,
} from '../features/notifications';
import { renderScreen } from '../test-utils';

const mockApi = {
  me: {
    get: jest.fn(),
    update: jest.fn(async (_p: { settings: object }): Promise<object> => ({})),
  },
  notifications: {
    list: jest.fn(),
    unreadCount: jest.fn(async () => 0),
    markRead: jest.fn(async () => {}),
    readAll: jest.fn(async () => {}),
    remove: jest.fn(async (_id: string) => {}),
    removeMany: jest.fn(async (_ids: string[]) => {}),
    removeAll: jest.fn(async () => {}),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

const item = (over: Record<string, unknown> = {}) => ({
  _id: 'n1',
  type: 'friend-request',
  title: '친구 요청',
  body: '나나님이 친구 요청을 보냈어요',
  data: { requestId: 'q1', userId: 'u1' },
  readAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

const settings = (over: Record<string, unknown> = {}) => ({
  _id: 'me',
  nickname: '나',
  settings: {
    notifyFriend: true,
    notifyChat: true,
    notifyRoom: true,
    notifyStudy: true,
    notifyAi: true,
    quietHours: null,
    mutedChatRoomIds: [],
    ...over,
  },
});

beforeEach(() => jest.clearAllMocks());

describe('알림함', () => {
  it('알림을 보여 주고, 누르면 읽음 처리하고 그 화면으로 간다', async () => {
    mockApi.notifications.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText(/나나님이 친구 요청을 보냈어요/));
    await waitFor(() => expect(mockApi.notifications.markRead).toHaveBeenCalledWith('n1'));
    expect(router.push).toHaveBeenCalledWith('/requests');
  });

  it('이미 읽은 알림은 다시 읽음 처리하지 않는다', async () => {
    mockApi.notifications.list.mockResolvedValue({
      items: [item({ readAt: new Date().toISOString() })],
      nextCursor: null,
    });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText(/나나님이 친구 요청을 보냈어요/));
    expect(router.push).toHaveBeenCalledWith('/requests');
    expect(mockApi.notifications.markRead).not.toHaveBeenCalled();
  });

  it('탭 화면으로 가는 알림은 있던 (tabs) 로 돌아가 연다(#674)', async () => {
    mockApi.notifications.list.mockResolvedValue({
      items: [item({ type: 'room-kicked', body: '방에서 내보내졌어요', data: { roomId: 'r1' } })],
      nextCursor: null,
    });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText(/방에서 내보내졌어요/));
    expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/studyroom');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('옆으로 밀어 「삭제」를 누르면 바로 지우고 목록에서 뺀다', async () => {
    mockApi.notifications.list.mockResolvedValueOnce({ items: [item()], nextCursor: null });
    mockApi.notifications.list.mockResolvedValue({ items: [], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByLabelText('친구 요청 삭제'));
    await waitFor(() => expect(mockApi.notifications.remove).toHaveBeenCalledWith('n1'));
    await waitFor(() => expect(screen.queryByText(/나나님이 친구 요청을 보냈어요/)).toBeNull());
    expect(router.push).not.toHaveBeenCalled();
  });
  it('지우지 못하면 알림을 목록에 되돌린다(다시 읽기도 실패해도)', async () => {
    mockApi.notifications.list.mockResolvedValueOnce({ items: [item()], nextCursor: null });
    mockApi.notifications.list.mockRejectedValue(new Error('offline'));
    mockApi.notifications.remove.mockRejectedValueOnce(new Error('offline'));
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByLabelText('친구 요청 삭제'));
    await waitFor(() => expect(mockApi.notifications.remove).toHaveBeenCalled());
    expect(await screen.findByText(/나나님이 친구 요청을 보냈어요/)).toBeTruthy();
  });
  it('잇달아 지우다 앞의 것만 실패하면 그것만 되돌리고, 지운 다른 알림은 되살리지 않는다', async () => {
    mockApi.notifications.list.mockResolvedValueOnce({
      items: [item(), item({ _id: 'n2', title: '퀴즈 완성', body: '퀴즈가 준비됐어요' })],
      nextCursor: null,
    });
    mockApi.notifications.list.mockRejectedValue(new Error('offline'));
    let failA!: (e: Error) => void;
    mockApi.notifications.remove
      .mockImplementationOnce(() => new Promise<void>((_ok, no) => (failA = no)))
      .mockResolvedValueOnce(undefined);
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByLabelText('친구 요청 삭제'));
    await fireEvent.press(await screen.findByLabelText('퀴즈 완성 삭제'));
    await waitFor(() => expect(mockApi.notifications.remove).toHaveBeenCalledTimes(2));
    await act(async () => failA(new Error('offline')));
    expect(await screen.findByText(/나나님이 친구 요청을 보냈어요/)).toBeTruthy();
    expect(screen.queryByText(/퀴즈가 준비됐어요/)).toBeNull();
  });
  it('꾹 누르면 한 번 묻고, 「삭제」를 골라야 지운다', async () => {
    mockApi.notifications.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent(await screen.findByText(/나나님이 친구 요청을 보냈어요/), 'longPress');
    expect(await screen.findByText('알림을 삭제할까요?')).toBeTruthy();
    await fireEvent.press(screen.getByText('취소'));
    expect(mockApi.notifications.remove).not.toHaveBeenCalled();
    await fireEvent(screen.getByText(/나나님이 친구 요청을 보냈어요/), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(mockApi.notifications.remove).toHaveBeenCalledWith('n1'));
    expect(router.push).not.toHaveBeenCalled();
  });
  it('편집에서 고른 알림만 지운다', async () => {
    mockApi.notifications.list.mockResolvedValue({
      items: [
        item(),
        item({ _id: 'n2', title: '퀴즈 완성' }),
        item({ _id: 'n3', title: '새 메시지' }),
      ],
      nextCursor: null,
    });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText('편집'));
    await fireEvent.press(screen.getByText('친구 요청'));
    await fireEvent.press(screen.getByText('새 메시지'));
    // 누르면 이동하지 않고 고르기만 한다
    expect(router.push).not.toHaveBeenCalled();
    expect(mockApi.notifications.markRead).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('고른 알림 2개 삭제'));
    expect(await screen.findByText('알림 2개를 삭제할까요?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() =>
      expect(mockApi.notifications.removeMany).toHaveBeenCalledWith(['n1', 'n3']),
    );
    expect(mockApi.notifications.removeAll).not.toHaveBeenCalled();
    // 다 지우면 편집을 끝낸다
    expect(await screen.findByText('편집')).toBeTruthy();
  });
  it('전체 선택 삭제는 아직 안 불러온 알림까지 모두 지운다, 하나를 빼면 나머지만 지운다', async () => {
    mockApi.notifications.list.mockResolvedValue({
      items: [item(), item({ _id: 'n2', title: '퀴즈 완성' })],
      nextCursor: 'n2',
    });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText('편집'));
    await fireEvent.press(screen.getByText('전체 선택'));
    expect(screen.getByText('삭제 (전체)')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('모든 알림 삭제'));
    expect(await screen.findByText('알림을 모두 삭제할까요?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '취소' }));
    // 하나를 빼면 보이는 것 중 나머지만
    await fireEvent.press(screen.getByText('퀴즈 완성'));
    await fireEvent.press(screen.getByLabelText('고른 알림 1개 삭제'));
    await fireEvent.press(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(mockApi.notifications.removeMany).toHaveBeenCalledWith(['n1']));
    expect(mockApi.notifications.removeAll).not.toHaveBeenCalled();
  });
  it('전체 선택 뒤 삭제하면 모두 지운다', async () => {
    mockApi.notifications.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText('편집'));
    await fireEvent.press(screen.getByText('전체 선택'));
    await fireEvent.press(screen.getByLabelText('모든 알림 삭제'));
    await fireEvent.press(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(mockApi.notifications.removeAll).toHaveBeenCalled());
  });
  it('100개가 넘게 고르면 100개씩 나눠 지운다', async () => {
    const many = Array.from({ length: 120 }, (_, i) => item({ _id: `n${i}`, title: `알림${i}` }));
    mockApi.notifications.list.mockResolvedValue({ items: many, nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText('편집'));
    await fireEvent.press(screen.getByText('전체 선택'));
    await fireEvent.press(screen.getByText('알림0'));
    await fireEvent.press(screen.getByLabelText('고른 알림 119개 삭제'));
    await fireEvent.press(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(mockApi.notifications.removeMany).toHaveBeenCalledTimes(2));
    const [a, b] = mockApi.notifications.removeMany.mock.calls.map(([ids]) => ids);
    expect(a).toHaveLength(100);
    expect(b).toHaveLength(19);
    expect([...a!, ...b!]).toEqual(many.slice(1).map((n) => n._id));
  });
  it('모두 읽음', async () => {
    mockApi.notifications.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText('모두 읽음'));
    await waitFor(() => expect(mockApi.notifications.readAll).toHaveBeenCalled());
  });

  it('읽음 처리가 끝난 뒤에 읽지 않은 수를 다시 읽는다', async () => {
    let done!: () => void;
    mockApi.notifications.markRead.mockImplementationOnce(
      () => new Promise<void>((r) => (done = r)),
    );
    mockApi.notifications.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await renderScreen(<InboxScreen />);
    await fireEvent.press(await screen.findByText(/나나님이 친구 요청을 보냈어요/));
    const before = mockApi.notifications.unreadCount.mock.calls.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(mockApi.notifications.unreadCount.mock.calls.length).toBe(before);
    done();
    await waitFor(() =>
      expect(mockApi.notifications.unreadCount.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('불러온 알림은 다 읽었어도 안 읽은 알림이 남아 있으면 모두 읽음을 누를 수 있다', async () => {
    mockApi.notifications.unreadCount.mockResolvedValue(25);
    mockApi.notifications.list.mockResolvedValue({
      items: [item({ readAt: new Date().toISOString() })],
      nextCursor: 'c1',
    });
    await renderScreen(<InboxScreen />);
    await waitFor(() => expect(mockApi.notifications.unreadCount).toHaveBeenCalled());
    await fireEvent.press(await screen.findByText('모두 읽음'));
    await waitFor(() => expect(mockApi.notifications.readAll).toHaveBeenCalled());
    mockApi.notifications.unreadCount.mockResolvedValue(0);
  });

  it('비어 있으면 안내', async () => {
    mockApi.notifications.list.mockResolvedValue({ items: [], nextCursor: null });
    await renderScreen(<InboxScreen />);
    expect(await screen.findByText('아직 받은 알림이 없어요')).toBeTruthy();
  });
});

describe('홈 종 아이콘', () => {
  it('읽지 않은 수를 보여 주고 누르면 알림함으로', async () => {
    mockApi.notifications.unreadCount.mockResolvedValueOnce(3);
    await renderScreen(<BellButton />);
    await fireEvent.press(await screen.findByLabelText('알림 3개 안 읽음'));
    expect(router.push).toHaveBeenCalledWith('/notifications');
  });
});

describe('알림 설정', () => {
  it('종류별로 끄면 그 설정만 저장한다', async () => {
    mockApi.me.get.mockResolvedValue(settings());
    await renderScreen(<NotificationSettingsScreen />);
    await fireEvent(await screen.findByLabelText('채팅 알림'), 'valueChange', false);
    await waitFor(() =>
      expect(mockApi.me.update).toHaveBeenCalledWith({ settings: { notifyChat: false } }),
    );
  });

  it('저장에 실패하면(오프라인) 스위치를 원래 값으로 되돌린다', async () => {
    // 처음만 읽히고 그 뒤 다시 읽기도 실패한다(네트워크 끊김)
    mockApi.me.get.mockResolvedValueOnce(settings()).mockRejectedValue(new Error('offline'));
    let fail!: (e: Error) => void;
    mockApi.me.update.mockImplementationOnce(() => new Promise<object>((_, rej) => (fail = rej)));
    await renderScreen(<NotificationSettingsScreen />);
    await fireEvent(await screen.findByLabelText('채팅 알림'), 'valueChange', false);
    await waitFor(() => expect(screen.getByLabelText('채팅 알림').props.value).toBe(false));
    fail(new Error('offline'));
    await waitFor(() => expect(screen.getByLabelText('채팅 알림').props.value).toBe(true));
    mockApi.me.get.mockReset();
  });

  it('조용한 시간을 켜면 23:00~07:00, 끄면 없앤다', async () => {
    mockApi.me.get.mockResolvedValue(settings());
    await renderScreen(<NotificationSettingsScreen />);
    await fireEvent(await screen.findByLabelText('조용한 시간'), 'valueChange', true);
    await waitFor(() =>
      expect(mockApi.me.update).toHaveBeenCalledWith({
        settings: { quietHours: { start: '23:00', end: '07:00' } },
      }),
    );
  });

  it('끝 시각으로 시작과 같은 시각은 고를 수 없다(같으면 조용한 시간이 꺼진다)', async () => {
    mockApi.me.get.mockResolvedValue(settings({ quietHours: { start: '23:00', end: '07:00' } }));
    await renderScreen(<NotificationSettingsScreen />);
    await fireEvent.press(await screen.findByText('07:00'));
    const tiles = await screen.findAllByText('23:00');
    await fireEvent.press(tiles[tiles.length - 1]!);
    expect(mockApi.me.update).not.toHaveBeenCalled();
  });

  it('조용한 시간 시작 시각을 고른다', async () => {
    mockApi.me.get.mockResolvedValue(settings({ quietHours: { start: '23:00', end: '07:00' } }));
    await renderScreen(<NotificationSettingsScreen />);
    await fireEvent.press(await screen.findByText('23:00'));
    await fireEvent.press(await screen.findByText('22:00'));
    await waitFor(() =>
      expect(mockApi.me.update).toHaveBeenCalledWith({
        settings: { quietHours: { start: '22:00', end: '07:00' } },
      }),
    );
  });
});

describe('채팅 음소거', () => {
  function Probe({ id }: { id?: string }) {
    const mute = useChatMute(id);
    return (
      <Text onPress={mute.toggle} accessibilityLabel="probe">
        {!mute.ready ? '불러오는 중' : mute.muted ? '음소거됨' : '알림 받음'}
      </Text>
    );
  }

  it('이 채팅방을 음소거 목록에 넣고 뺀다(다른 방은 그대로)', async () => {
    // 저장한 값이 다시 읽혀 오게 한다
    let saved = settings({ mutedChatRoomIds: ['c0'] });
    mockApi.me.get.mockImplementation(async () => saved);
    mockApi.me.update.mockImplementation(async (p: { settings: object }) => {
      saved = { ...saved, settings: { ...saved.settings, ...p.settings } };
      return saved;
    });
    await renderScreen(<Probe id="c1" />);
    await fireEvent.press(await screen.findByText('알림 받음'));
    await waitFor(() =>
      expect(mockApi.me.update).toHaveBeenCalledWith({
        settings: { mutedChatRoomIds: ['c0', 'c1'] },
      }),
    );
    expect(await screen.findByText('음소거됨')).toBeTruthy();
  });
});
