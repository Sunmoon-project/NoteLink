import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, Tabs, router, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Pressable, Text } from 'react-native';

import { useOpenFriendShare } from '../features/content/friend-share';
import { openNotification } from '../features/notifications';
import { RoomCardsScreen } from '../features/studyroom/room';
import { noteTabPath, noteViewPath } from '../lib/note-routes';
import { useAuth } from '../stores/auth';
// 실제 라우트 파일(노트 탭 레이아웃 · 탭 안 상세 · 탭 밖 노트 보기)을 그대로 쓴다
import * as NoteLayout from '../../app/(tabs)/note/_layout';
import TabDoc from '../../app/(tabs)/note/doc/[id]';
import TabHand from '../../app/(tabs)/note/hand/[id]';
import TabRec from '../../app/(tabs)/note/rec/[id]';
import ViewDoc from '../../app/note-view/doc/[id]';
import ViewHand from '../../app/note-view/hand/[id]';
import ViewRec from '../../app/note-view/rec/[id]';

// #674: 탭 밖 화면(방 · 1:1 채팅 · 알림함)에서 노트 · 탭 화면을 열 때 루트 Stack 에 (tabs) 가 겹쳐 쌓이지 않는지
// 목이 아닌 실제 Stack · Tabs 에서 본다. 겹쳐 쌓이면 뒤로 가기가 연 화면이 아니라 홈으로 가고, 노트 탭이 그 상세에 고정된다

const mockApi = {
  rooms: { get: jest.fn(), shared: jest.fn(), chatRoomId: jest.fn() },
  social: { friends: jest.fn(), messages: jest.fn() },
  content: { material: jest.fn(), friendShare: jest.fn(), copyFriendShare: jest.fn() },
  notifications: { markRead: jest.fn(async () => {}), unreadCount: jest.fn(async () => 0) },
};
jest.mock('expo-router', () => jest.requireActual('expo-router'));
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: jest.fn() }));
jest.mock('../lib/livekit', () => ({ useLiveRoom: jest.fn() }));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-calendar', () => ({}));
// 상세 화면 자체(녹음 재생 · 3D 아바타 등)는 이 시험의 관심이 아니다. 어느 화면인지와 친구 공유 아래 버튼만 그린다
jest.mock('../features/content/detail', () => {
  const React = jest.requireActual('react');
  const { Text: T } = jest.requireActual('react-native');
  const { useLocalSearchParams: params } = jest.requireActual('expo-router');
  const { FriendShareFooter } = jest.requireActual('../features/content/friend-share');
  const h = React['create' + 'Element'];
  const make = (name: string) =>
    function Detail() {
      const { id, share } = params();
      return h(
        React.Fragment,
        null,
        h(T, null, `${name} 상세 ${id}`),
        share ? h(FriendShareFooter, { shareId: share }) : null,
      );
    };
  return {
    DocDetailScreen: make('문서'),
    HandDetailScreen: make('필기'),
    RecDetailScreen: make('녹음'),
  };
});

const label = (text: string) =>
  function Label() {
    return <Text>{text}</Text>;
  };

/** 1:1 채팅의 노트 공유 카드 자리 */
function ChatStub() {
  const open = useOpenFriendShare();
  return (
    <Pressable onPress={() => void open('s1')}>
      <Text>공유 카드</Text>
    </Pressable>
  );
}

/** 알림함의 알림 한 줄 자리 */
function InboxStub() {
  const { type, roomId } = useLocalSearchParams<{ type: string; roomId?: string }>();
  const n = { _id: 'n1', type, data: roomId ? { roomId } : {}, readAt: 'read' };
  return (
    <Pressable onPress={() => openNotification(n as never)}>
      <Text>알림</Text>
    </Pressable>
  );
}

const share = {
  _id: 's1',
  materialId: 'n1',
  ownerId: 'u1',
  ownerNickname: '민지',
  friendId: 'me',
  kind: 'handwriting',
  title: '받은 필기',
  active: true,
  mine: false,
};

const app = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderRouter(
    {
      _layout: () => (
        <QueryClientProvider client={qc}>
          <Stack screenOptions={{ headerShown: false }} />
        </QueryClientProvider>
      ),
      '(tabs)/_layout': () => <Tabs screenOptions={{ headerShown: false }} />,
      '(tabs)/(home)/index': label('홈'),
      // 노트 탭 스택은 실제 레이아웃(아래에 노트 목록을 까는 initialRouteName)을 쓴다
      '(tabs)/note/_layout': NoteLayout,
      '(tabs)/note/index': label('노트 목록'),
      '(tabs)/note/folder/[id]': label('폴더'),
      '(tabs)/note/doc/[id]': TabDoc,
      '(tabs)/note/hand/[id]': TabHand,
      '(tabs)/note/rec/[id]': TabRec,
      '(tabs)/quiz/index': label('퀴즈 탭'),
      '(tabs)/studyroom/index': label('스터디룸 탭'),
      'note-view/doc/[id]': ViewDoc,
      'note-view/hand/[id]': ViewHand,
      'note-view/rec/[id]': ViewRec,
      'room/cards': RoomCardsScreen,
      'room/[id]': label('스터디룸 방'),
      'chat/[id]': ChatStub,
      notifications: InboxStub,
    },
    { initialUrl: '/' },
  );
};

type NavState = { routes: { name: string; state?: NavState }[] } | undefined;
/** 화면 트리 전체에서 (tabs) 가 몇 개 쌓였는지 */
const countTabs = (s: NavState): number =>
  (s?.routes ?? []).reduce(
    (n, r) => n + (r.name === '(tabs)' ? 1 : 0) + countTabs(r.state as NavState),
    0,
  );

beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ userId: 'me' });
  mockApi.rooms.get.mockResolvedValue({ _id: 'r1', title: '방', hostId: 'host', members: [] });
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.friends.mockResolvedValue([]);
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.content.friendShare.mockResolvedValue(share);
});

afterEach(() => {
  // renderRouter가 켠 가짜 타이머를 다음 시험으로 넘기지 않는다
  jest.useRealTimers();
});

it('방 공유 자료에서 노트를 열고 뒤로 가면 방 공유 자료로 돌아오고, (tabs) 는 하나뿐이다', async () => {
  mockApi.rooms.shared.mockResolvedValue({
    items: [
      {
        _id: 'm',
        itemType: 'material',
        materialId: 'mat-1',
        quizSetId: null,
        title: '공유 노트',
        sharedByNickname: '민수',
      },
    ],
    flashcards: [],
  });
  mockApi.content.material.mockResolvedValue({ _id: 'mat-1', kind: 'document' });
  const r = app();
  await r;
  await act(async () => router.push({ pathname: '/room/cards', params: { id: 'r1' } }));
  await fireEvent.press(await screen.findByText('공유 노트'));
  expect(await screen.findByText('문서 상세 mat-1')).toBeTruthy();
  expect(r.getPathname()).toBe('/note-view/doc/mat-1');
  expect(countTabs(r.getRouterState() as NavState)).toBe(1);
  await act(async () => router.back());
  expect(r.getPathname()).toBe('/room/cards');
  // 노트 탭은 건드리지 않아 목록 그대로다
  await act(async () => router.back());
  await act(async () => router.navigate('/note'));
  expect(r.getPathname()).toBe('/note');
  expect(await screen.findByText('노트 목록')).toBeTruthy();
});

it('1:1 채팅 공유 카드로 연 노트에서 뒤로 가면 채팅으로 돌아온다', async () => {
  const r = app();
  await r;
  await act(async () => router.push({ pathname: '/chat/[id]', params: { id: 'u1' } }));
  await fireEvent.press(await screen.findByText('공유 카드'));
  expect(await screen.findByText('필기 상세 n1')).toBeTruthy();
  expect(r.getPathname()).toBe('/note-view/hand/n1');
  expect(r.getSearchParams()).toMatchObject({ share: 's1' });
  expect(countTabs(r.getRouterState() as NavState)).toBe(1);
  await act(async () => router.back());
  expect(r.getPathname()).toBe('/chat/u1');
});

it.each([
  ['노트 탭을 아직 안 열었으면 뒤로 가면 노트 목록', null, '/note'],
  ['노트 탭에서 폴더를 보던 중이면 뒤로 가면 그 폴더', '/note/folder/f0', '/note/folder/f0'],
  // 같은 종류(필기) 상세 위라도 그 자리를 바꾸지 않고 위에 쌓는다(상세는 id 마다 다른 화면)
  ['노트 탭에서 내 필기 상세를 보던 중이면 뒤로 가면 그 상세', '/note/hand/n5', '/note/hand/n5'],
] as const)(
  '「내 노트로 복사」 뒤에는 있던 노트 탭에서 사본을 연다 — %s',
  async (_n, visited, back) => {
    mockApi.content.copyFriendShare.mockResolvedValue({ _id: 'n2', folderId: 'f1' });
    const r = app();
    await r;
    if (visited) {
      await act(async () => router.navigate('/note'));
      await act(async () => router.push(visited));
    }
    await act(async () => router.push({ pathname: '/chat/[id]', params: { id: 'u1' } }));
    await fireEvent.press(await screen.findByText('공유 카드'));
    await fireEvent.press(await screen.findByRole('button', { name: '내 노트로 복사' }));
    expect(await screen.findByText('필기 상세 n2')).toBeTruthy();
    expect(r.getPathname()).toBe('/note/hand/n2');
    expect(countTabs(r.getRouterState() as NavState)).toBe(1);
    await act(async () => router.back());
    expect(r.getPathname()).toBe(back);
    expect(countTabs(r.getRouterState() as NavState)).toBe(1);
  },
);

it.each([
  ['today-review', '/quiz', '퀴즈 탭'],
  ['room-kicked', '/studyroom', '스터디룸 탭'],
  ['note-summary', '/note', '노트 목록'],
])('알림함에서 탭 화면으로 가는 알림(%s)은 있던 (tabs) 로 돌아간다', async (type, path, text) => {
  const r = app();
  await r;
  await act(async () => router.push({ pathname: '/notifications', params: { type } }));
  await fireEvent.press(await screen.findByText('알림'));
  expect(await screen.findByText(text)).toBeTruthy();
  expect(r.getPathname()).toBe(path);
  expect(countTabs(r.getRouterState() as NavState)).toBe(1);
});

it('노트 탭에서 폴더를 보다가 알림으로 노트 탭에 가면 목록이 나오고, 뒤로 가면 보던 폴더(탭 안 기록은 그대로)', async () => {
  const r = app();
  await r;
  await act(async () => router.navigate('/note'));
  await act(async () => router.push({ pathname: '/note/folder/[id]', params: { id: 'f0' } }));
  await act(async () =>
    router.push({ pathname: '/notifications', params: { type: 'note-summary' } }),
  );
  await fireEvent.press(await screen.findByText('알림'));
  expect(await screen.findByText('노트 목록')).toBeTruthy();
  expect(r.getPathname()).toBe('/note');
  expect(countTabs(r.getRouterState() as NavState)).toBe(1);
  await act(async () => router.back());
  expect(r.getPathname()).toBe('/note/folder/f0');
});

it('알림함에서 탭 밖 화면으로 가는 알림은 알림함 위에 쌓여, 뒤로 가면 알림함으로 돌아온다', async () => {
  const r = app();
  await r;
  await act(async () =>
    router.push({ pathname: '/notifications', params: { type: 'study-room-timer', roomId: 'r1' } }),
  );
  await fireEvent.press(await screen.findByText('알림'));
  expect(await screen.findByText('스터디룸 방')).toBeTruthy();
  expect(r.getPathname()).toBe('/room/r1');
  await act(async () => router.back());
  expect(r.getPathname()).toBe('/notifications');
  expect(countTabs(r.getRouterState() as NavState)).toBe(1);
});

it('모르는 노트 종류도 문서 화면으로 연다(예전과 같게)', () => {
  expect(noteViewPath('video' as never)).toBe('/note-view/doc/[id]');
  expect(noteViewPath(null)).toBe('/note-view/doc/[id]');
  expect(noteTabPath('recording')).toBe('/(tabs)/note/rec/[id]');
});
