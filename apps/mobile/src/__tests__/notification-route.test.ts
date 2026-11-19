// 알림(푸시 · 알림함)을 눌렀을 때 갈 화면과, 지금 보고 있는 채팅방 알림 배너를 숨기는 규칙(#560)
import { routeFor, showBanner, viewingChat } from '../lib/notification-route';

describe('알림 → 화면', () => {
  it('종류마다 갈 화면', () => {
    expect(routeFor({ type: 'friend-request' })).toBe('/requests');
    expect(routeFor({ type: 'friend-accepted', userId: 'u1' })).toBe('/friends');
    expect(routeFor({ type: 'timetable-shared', userId: 'u1' })).toBe('/friends');
    expect(routeFor({ type: 'chat-message', chatRoomId: 'c1', userId: 'u1' })).toEqual({
      pathname: '/chat/[id]',
      params: { id: 'u1' },
    });
    expect(
      routeFor({ type: 'chat-message', chatRoomId: 'c1', roomId: 'r1', userId: 'u1' }),
    ).toEqual({ pathname: '/room/[id]', params: { id: 'r1' } });
    expect(routeFor({ type: 'room-invite', userId: 'u1', roomId: 'r1' })).toEqual({
      pathname: '/chat/[id]',
      params: { id: 'u1' },
    });
    expect(routeFor({ type: 'room-kicked', roomId: 'r1' })).toBe('/(tabs)/studyroom');
    expect(routeFor({ type: 'room-shared', roomId: 'r1' })).toEqual({
      pathname: '/room/cards',
      params: { id: 'r1' },
    });
    expect(routeFor({ type: 'study-room-timer', roomId: 'r1' })).toEqual({
      pathname: '/room/[id]',
      params: { id: 'r1' },
    });
    expect(routeFor({ type: 'dday-remind' })).toBe('/dday');
    expect(routeFor({ type: 'goal-remind' })).toBe('/repeat');
    expect(routeFor({ type: 'today-review' })).toBe('/(tabs)/quiz');
    expect(routeFor({ type: 'note-summary', materialId: 'm1', status: 'succeeded' })).toEqual({
      pathname: '/result/[id]',
      params: { id: 'm1' },
    });
    expect(routeFor({ type: 'note-summary', materialId: 'm1', status: 'failed' })).toBe(
      '/(tabs)/note',
    );
    expect(routeFor({ type: 'quiz-ready', quizSetId: 's1', status: 'succeeded' })).toEqual({
      pathname: '/play/ready',
      params: { setId: 's1' },
    });
    expect(routeFor({ type: 'quiz-ready', quizSetId: 's1', status: 'failed' })).toBe(
      '/(tabs)/quiz',
    );
  });

  it('모르는 종류 · 필요한 id가 없으면 이동하지 않는다', () => {
    expect(routeFor({ type: 'something-new' })).toBeNull();
    expect(routeFor({ type: 'chat-message' })).toBeNull();
    expect(routeFor({ type: 'room-shared' })).toBeNull();
    expect(routeFor(null)).toBeNull();
    expect(routeFor({ type: 3 })).toBeNull();
  });
});

describe('보고 있는 채팅방 배너 숨김', () => {
  afterEach(() => viewingChat(null));

  it('지금 보고 있는 채팅방의 새 메시지 배너만 숨긴다', () => {
    viewingChat('c1');
    expect(showBanner({ type: 'chat-message', chatRoomId: 'c1' })).toBe(false);
    expect(showBanner({ type: 'chat-message', chatRoomId: 'c2' })).toBe(true);
    expect(showBanner({ type: 'friend-request' })).toBe(true);
    viewingChat(null);
    expect(showBanner({ type: 'chat-message', chatRoomId: 'c1' })).toBe(true);
  });
});
