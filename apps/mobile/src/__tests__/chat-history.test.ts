import type { Message } from '@notelink/shared';
import { loadCompleteChatHistory } from '../lib/chat-history';

const message = (i: number): Message => ({
  _id: String(i),
  chatRoomId: 'chat',
  senderId: 'user',
  type: 'text',
  text: String(i),
  sharedItemId: null,
  createdAt: new Date(1700000000000 + i * 1000).toISOString(),
});

it('50개를 초과해도 모든 페이지를 시간순으로 복구한다', async () => {
  const records = Array.from({ length: 125 }, (_, i) => message(i));
  const fetch = jest.fn(async (before?: string) => {
    const end = before === undefined ? records.length : Number(before);
    return records.slice(Math.max(0, end - 50), end);
  });
  const result = await loadCompleteChatHistory(fetch);
  expect(result.map((m) => m._id)).toEqual(records.map((m) => m._id));
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([undefined, '75', '25']);
});

it('페이지가 반복되면 무한 요청하지 않고 실패한다', async () => {
  const page = Array.from({ length: 50 }, (_, i) => message(i));
  await expect(loadCompleteChatHistory(async () => page)).rejects.toThrow('이어서 읽을 수 없어요');
});

it('연결이 끊겨 세대가 바뀌면 부분 결과를 확정하지 않는다', async () => {
  await expect(
    loadCompleteChatHistory(
      async () => Array.from({ length: 50 }, (_, i) => message(i)),
      () => false,
    ),
  ).rejects.toThrow('동기화가 중단');
});
