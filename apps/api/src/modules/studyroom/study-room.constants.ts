/** 스터디룸 "안에서의" 멤버 역할. 시스템 전역 role(user/admin)과는 다른 개념입니다. */
export const ROOM_MEMBER_ROLES = {
  HOST: 'host',
  MEMBER: 'member',
} as const;

/** 스터디룸 멤버 상태 */
export const ROOM_MEMBER_STATUS = {
  JOINED: 'joined',
  LEFT: 'left',
  KICKED: 'kicked',
} as const;
