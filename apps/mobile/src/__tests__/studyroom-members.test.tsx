import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { Friend, FriendRequest, StudyRoom } from '@notelink/shared';
import { router } from 'expo-router';
import { FriendAddScreen } from '../features/social/screens';
import { RoomMembersScreen } from '../features/studyroom/room-members';
import { RoomSettingsScreen } from '../features/studyroom/tools';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

// 스터디룸 방 안에서 가입한 멤버 전부를 보고, 멤버에게 친구 요청을 보낸다(FR-16)
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const member = (userId: string, nickname: string) => ({
  userId,
  nickname,
  role: 'member' as const,
  status: 'joined' as const,
});
const room = {
  _id: 'r1',
  title: '알고리즘 스터디',
  hostId: 'me',
  inviteCode: 'AB1234',
  members: [
    member('me', '본인'),
    member('f', '친구된이'),
    member('r', '요청온이'),
    member('s', '요청간이'),
    member('n', '처음본이'),
  ],
  memberCount: 5,
  maxCapacity: 6,
} as unknown as StudyRoom;
const person = (userId: string, nickname: string) =>
  ({ _id: `fr-${userId}`, userId, nickname, status: 'offline' }) as Friend;

let sent: string[];
beforeEach(() => {
  useAuth.setState({ userId: 'me' });
  setParams({ id: 'r1' });
  sent = ['s'];
  jest.spyOn(api.rooms, 'get').mockResolvedValue(room);
  jest.spyOn(api.social, 'friends').mockResolvedValue([person('f', '친구된이')]);
  jest.spyOn(api.social, 'received').mockResolvedValue([
    {
      _id: 'req-r',
      requester: person('r', '요청온이'),
      requestedAt: '2026-11-20T00:00:00.000Z',
    } as FriendRequest,
  ]);
  jest.spyOn(api.social, 'sent').mockImplementation(async () => [...sent]);
});
afterEach(() => jest.restoreAllMocks());

const row = (name: string) => within(screen.getByTestId(`member-${name}`));

describe('스터디룸 멤버 창', () => {
  it('가입한 멤버 전부를 보이고, 친구 상태마다 버튼이 다르다', async () => {
    await renderScreen(<RoomMembersScreen />);
    expect(await screen.findByText('멤버 5명')).toBeTruthy();
    await waitFor(() => expect(row('n').getByRole('button', { name: '친구 요청' })).toBeTruthy());
    expect(row('me').getByText('나')).toBeTruthy();
    expect(row('me').queryByRole('button')).toBeNull();
    expect(row('f').getByRole('button', { name: '친구' })).toBeDisabled();
    expect(row('r').getByRole('button', { name: '수락' })).toBeEnabled();
    expect(row('s').getByRole('button', { name: '요청 보냄' })).toBeDisabled();
  });

  it('「친구 요청」을 누르면 요청을 보내고 「요청 보냄」으로 바뀐다', async () => {
    const send = jest.spyOn(api.social, 'sendRequest').mockImplementation(async (userId) => {
      sent.push(userId);
    });
    await renderScreen(<RoomMembersScreen />);
    await screen.findByTestId('member-n');
    await fireEvent.press(await row('n').findByRole('button', { name: '친구 요청' }));
    expect(send).toHaveBeenCalledWith('n');
    await waitFor(() => expect(row('n').getByRole('button', { name: '요청 보냄' })).toBeDisabled());
  });

  it('받은 요청은 「수락」으로 바로 친구가 된다', async () => {
    const respond = jest.spyOn(api.social, 'respond').mockResolvedValue(undefined);
    await renderScreen(<RoomMembersScreen />);
    await screen.findByTestId('member-r');
    await fireEvent.press(await row('r').findByRole('button', { name: '수락' }));
    expect(respond).toHaveBeenCalledWith('req-r', true);
  });

  it('방 설정의 「멤버 n명」 줄에서 들어간다', async () => {
    jest.spyOn(api.rooms, 'chatRoomId').mockResolvedValue('chat-1');
    await renderScreen(<RoomSettingsScreen />);
    await fireEvent.press(await screen.findByText('멤버 5명'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/room/members', params: { id: 'r1' } });
  });
});

describe('친구 추가 화면', () => {
  it('예전에 보낸 요청도 다시 열면 「요청 보냄」으로 보인다', async () => {
    jest.spyOn(api.social, 'search').mockResolvedValue([person('s', '요청간이')]);
    await renderScreen(<FriendAddScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('닉네임을 입력해주세요.'), '요청간이');
    expect(await screen.findByRole('button', { name: '요청 보냄' })).toBeDisabled();
  });
});
