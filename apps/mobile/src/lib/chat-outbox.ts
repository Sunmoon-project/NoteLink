import { readDb, writeDb } from './local/storage';

export type QueuedChatMessage = {
  clientId: string;
  chatRoomId: string;
  text: string;
  createdAt: string;
};

const key = (userId: string, roomId: string) =>
  `chat-outbox-${encodeURIComponent(userId).length}-${encodeURIComponent(userId)}-${encodeURIComponent(roomId)}`;

export function readChatOutbox(userId: string, roomId: string): QueuedChatMessage[] {
  const data = readDb(key(userId, roomId));
  if (data === null) return [];
  if (
    !Array.isArray(data) ||
    !data.every(
      (item) =>
        item &&
        typeof item.clientId === 'string' &&
        typeof item.chatRoomId === 'string' &&
        typeof item.text === 'string' &&
        typeof item.createdAt === 'string',
    )
  ) {
    throw new Error('전송 대기 메시지를 읽지 못했어요');
  }
  return data as QueuedChatMessage[];
}

export function addChatOutbox(userId: string, roomId: string, item: QueuedChatMessage) {
  const entries = readChatOutbox(userId, roomId);
  if (!entries.some((entry) => entry.clientId === item.clientId)) {
    writeDb(key(userId, roomId), [...entries, item]);
  }
}

export function removeChatOutbox(userId: string, roomId: string, clientId: string) {
  const entries = readChatOutbox(userId, roomId);
  writeDb(
    key(userId, roomId),
    entries.filter((entry) => entry.clientId !== clientId),
  );
}
