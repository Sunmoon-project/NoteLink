/**
 * 스터디룸 채팅 Socket.IO 이벤트 이름.
 * REST가 "경로"로 분기하듯, 소켓은 "이벤트 이름"으로 분기합니다.
 */
export const CHAT_EVENTS = {
  // 클라이언트 → 서버
  JOIN: 'chat:join', // 방 입장 { roomId }
  LEAVE: 'chat:leave', // 방 퇴장 { roomId }
  SEND: 'chat:send', // 메시지 전송 { roomId, text }

  // 서버 → 클라이언트
  MESSAGE: 'chat:message', // 새 메시지 수신
  JOINED: 'chat:joined', // 입장 확인
  ERROR: 'chat:error', // 오류 알림
} as const;

/** messages.type 값 */
export const MESSAGE_TYPES = {
  TEXT: 'text',
  SYSTEM: 'system',
  SHARED_ITEM: 'shared_item',
} as const;
