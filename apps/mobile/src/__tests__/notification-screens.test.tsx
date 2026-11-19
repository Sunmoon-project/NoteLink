// 알림함 · 알림 설정 · 채팅 음소거(#560)
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
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
