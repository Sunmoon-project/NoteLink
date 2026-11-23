import { router, type Href } from 'expo-router';

/** 알림 data(푸시 · 알림함 공통). 서버가 넣는 값: type과 종류별 id(apps/api의 각 알림 서비스) */
type Data = Record<string, unknown> | null | undefined;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** 알림을 눌렀을 때 갈 화면. 모르는 종류이거나 필요한 id가 없으면 null(이동하지 않는다) */
export function routeFor(data: Data): Href | null {
  const type = str(data?.type);
  const roomId = str(data?.roomId);
  const userId = str(data?.userId);
  const ok = data?.status === 'succeeded';
  const room = (pathname: '/room/[id]' | '/room/cards') =>
    roomId ? ({ pathname, params: { id: roomId } } as Href) : null;
  const chat = () => (userId ? ({ pathname: '/chat/[id]', params: { id: userId } } as Href) : null);
  switch (type) {
    case 'friend-request':
      return '/requests';
    case 'friend-accepted':
    case 'timetable-shared':
      return '/friends';
    case 'chat-message':
      // 방 채팅이면 방으로, 1:1이면 보낸 사람과의 채팅으로
      return roomId ? room('/room/[id]') : chat();
    case 'room-invite':
      return chat(); // 초대는 1:1 채팅의 초대 카드로 온다
    case 'room-kicked':
      return '/(tabs)/studyroom';
    case 'room-shared':
      return room('/room/cards');
    case 'study-room-timer':
      return room('/room/[id]');
    case 'dday-remind':
      return '/dday';
    case 'goal-remind':
      return '/repeat';
    case 'today-review':
      return '/(tabs)/quiz';
    case 'note-summary': {
      const id = str(data?.materialId);
      return ok && id ? { pathname: '/result/[id]', params: { id } } : '/(tabs)/note';
    }
    case 'quiz-ready': {
      const setId = str(data?.quizSetId);
      return ok && setId ? { pathname: '/play/ready', params: { setId } } : '/(tabs)/quiz';
    }
    default:
      return null;
  }
}

/**
 * 알림이 가리키는 화면으로 간다(알림함 · 푸시 공통).
 * 탭 화면(`/(tabs)/…`)은 있던 (tabs) 로 돌아가 그 탭을 연다(dismissTo). push 하면 루트 Stack 에 (tabs) 가 하나 더 쌓여
 * 뒤로 가기가 홈으로 새고 그 탭이 연 화면에 고정된다(#674). 탭 밖 화면은 지금 화면 위에 쌓아 뒤로 가면 돌아온다
 */
export function openRoute(to: Href) {
  const path = typeof to === 'string' ? to : to.pathname;
  if (path.startsWith('/(tabs)')) router.dismissTo(to);
  else router.push(to);
}

/** 지금 화면에 보이는 채팅방(1:1 · 스터디룸). 그 방의 새 메시지는 앱 안 배너를 띄우지 않는다 */
let viewing: string | null = null;

/** 채팅방을 보기 시작할 때 부르고, 돌려받은 함수로 끝낸다(다른 방으로 바로 옮겨 가도 새 방 표시를 지우지 않는다) */
export function viewingChat(chatRoomId: string | null): () => void {
  viewing = chatRoomId;
  return () => {
    if (viewing === chatRoomId) viewing = null;
  };
}

/** 앱이 앞에 있을 때 이 알림을 배너로 띄울지 */
export function showBanner(data: Data): boolean {
  return !(data?.type === 'chat-message' && viewing && str(data.chatRoomId) === viewing);
}
