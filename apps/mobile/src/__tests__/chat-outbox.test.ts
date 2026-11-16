import { addChatOutbox, readChatOutbox, removeChatOutbox } from '../lib/chat-outbox';

const mockFiles = new Map<string, unknown>();
jest.mock('../lib/local/storage', () => ({
  readDb: (key: string) => mockFiles.get(key) ?? null,
  writeDb: (key: string, value: unknown) => mockFiles.set(key, value),
}));
const message = {
  clientId: 'one',
  chatRoomId: 'chat',
  text: '안녕',
  createdAt: '2026-01-01T00:00:00.000Z',
};
beforeEach(() => mockFiles.clear());

it('계정과 방별로 대기열을 보관하고 확인받은 메시지만 제거한다', () => {
  addChatOutbox('user1', 'room1', message);
  addChatOutbox('user1', 'room1', message);
  addChatOutbox('user2', 'room1', { ...message, clientId: 'two' });
  expect(readChatOutbox('user1', 'room1')).toEqual([message]);
  expect(readChatOutbox('user1', 'room2')).toEqual([]);
  removeChatOutbox('user1', 'room1', 'one');
  expect(readChatOutbox('user1', 'room1')).toEqual([]);
  expect(readChatOutbox('user2', 'room1')).toHaveLength(1);
});

it('깨진 대기열을 빈 목록으로 취급하지 않는다', () => {
  mockFiles.set('chat-outbox-5-user1-room1', { broken: true });
  expect(() => addChatOutbox('user1', 'room1', message)).toThrow();
  expect(mockFiles.get('chat-outbox-5-user1-room1')).toEqual({ broken: true });
});
