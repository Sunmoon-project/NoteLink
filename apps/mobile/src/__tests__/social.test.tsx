import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { FriendAddScreen, ChatScreen } from '../features/social/screens';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';
import { router } from 'expo-router';

const mockApi = {
  rooms: { join: jest.fn() },
  social: {
    search: jest.fn(),
    sendRequest: jest.fn(async () => {}),
    openDirect: jest.fn(async () => ({ _id: 'room1' })),
    messages: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: jest.requireActual('../lib/api/http').ApiError,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const mockSocketHandlers = new Map<string, (message: unknown) => void>();
const mockEmit = jest.fn();
jest.mock('../lib/socket', () => ({
  socket: {
    on: (event: string, handler: (message: unknown) => void) => {
      mockSocketHandlers.set(event, handler);
      return () => mockSocketHandlers.delete(event);
    },
    emit: (...args: unknown[]) => mockEmit(...args),
  },
}));

const user = (id: string, nickname: string) => ({
  userId: id,
  nickname,
  handle: `@${id}`,
  mutualCount: 0,
});

// PR #33 리뷰
describe('친구 추가', () => {
  it('검색된 사람 모두에게 요청을 보낼 수 있다', async () => {
    mockApi.social.search.mockResolvedValue([user('u1', '지우'), user('u2', '지민')]);
    await renderScreen(<FriendAddScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('닉네임을 입력해주세요.'), '지');
    expect(await screen.findByText('지민')).toBeTruthy();
    expect(screen.getByText('검색 결과 2')).toBeTruthy();
    const buttons = screen.getAllByText('친구 요청 보내기');
    expect(buttons).toHaveLength(2);
    await fireEvent.press(buttons[1]!);
    await act(async () => {});
    expect(mockApi.social.sendRequest).toHaveBeenCalledWith('u2');
    expect(await screen.findByText('요청 보냄')).toBeTruthy();
    expect(screen.getAllByText('친구 요청 보내기')).toHaveLength(1);
  });

  it('서버가 거절 이유를 알려 주면(이미 친구 등) 그 문구를 보여 준다', async () => {
    const { ApiError } = jest.requireActual('../lib/api/http');
    const { useToast } = jest.requireActual('../stores/toast');
    mockApi.social.search.mockResolvedValue([user('u1', '지우')]);
    mockApi.social.sendRequest.mockRejectedValueOnce(
      new ApiError('FRIEND_ALREADY', '이미 친구예요', 409),
    );
    await renderScreen(<FriendAddScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('닉네임을 입력해주세요.'), '지우');
    await fireEvent.press(await screen.findByText('친구 요청 보내기'));
    await waitFor(() => expect(JSON.stringify(useToast.getState())).toContain('이미 친구예요'));
  });
});

describe('1:1 채팅', () => {
  it('로그인한 사용자 ID로 내 메시지를 가린다', async () => {
    useAuth.setState({ userId: '665f0c1a2b3c4d5e6f708192' });
    setParams({ id: 'u1', name: '지우' });
    mockApi.social.messages.mockResolvedValue([
      {
        _id: 'm1',
        chatRoomId: 'room1',
        senderId: '665f0c1a2b3c4d5e6f708192',
        text: '내가 보낸 말',
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        _id: 'm2',
        chatRoomId: 'room1',
        senderId: 'u1',
        text: '친구가 보낸 말',
        createdAt: '2026-10-27T00:01:00.000Z',
      },
    ]);
    await renderScreen(<ChatScreen />);
    const mine = await screen.findByText('내가 보낸 말');
    const theirs = screen.getByText('친구가 보낸 말');
    expect(mine.props.className).toContain('text-white');
    expect(theirs.props.className).toContain('text-ink');
  });
});

describe('채팅 중복 수신', () => {
  it('같은 메시지를 소켓 이벤트 다음 ACK로 받아도 한 번만 표시한다', async () => {
    setParams({ id: 'u1', name: '지우' });
    mockApi.social.messages.mockClear();
    mockEmit.mockClear();
    mockApi.social.messages.mockResolvedValue([]);
    const message = {
      _id: 'event-and-ack',
      chatRoomId: 'room1',
      senderId: 'me',
      text: '한 번 보낸 말',
      createdAt: '2026-10-29T00:00:00.000Z',
    };
    await renderScreen(<ChatScreen />);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
    await act(async () => {});
    await fireEvent.changeText(screen.getByPlaceholderText('메시지 보내기'), message.text);
    await fireEvent.press(screen.getByText('전송'));
    expect(mockEmit).toHaveBeenCalledWith('chat:send', expect.anything(), expect.any(Function));
    const ack = mockEmit.mock.calls.at(-1)![2] as (m: typeof message) => void;
    await act(async () => {
      mockSocketHandlers.get('chat:message')!(message);
      ack(message);
    });
    await waitFor(() => expect(screen.getAllByText(message.text)).toHaveLength(1));
  });
});

it('1:1 채팅의 스터디룸 초대 카드에서 참여 코드를 제출하고 방으로 이동한다', async () => {
  setParams({ id: 'u1', name: '지우' });
  mockApi.social.messages.mockResolvedValue([
    {
      _id: 'room-invite-1',
      chatRoomId: 'room1',
      senderId: 'me',
      type: 'study_room_invite',
      text: '스터디룸에 초대했어요.',
      sharedItemId: null,
      studyRoomInvite: {
        roomId: 'invite-room',
        title: '수학 스터디',
        inviteCode: 'AB12CD',
      },
      createdAt: '2026-11-14T00:00:00.000Z',
    },
  ]);
  mockApi.rooms.join.mockResolvedValue({ _id: 'joined-room' });

  await renderScreen(<ChatScreen />);
  await fireEvent.press(await screen.findByText('스터디룸 참여하기'));

  await waitFor(() => expect(mockApi.rooms.join).toHaveBeenCalledWith('AB12CD'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/room/[id]',
    params: { id: 'joined-room' },
  });
});
