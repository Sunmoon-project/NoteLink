import type { Message } from '@notelink/shared';
import { mockApi } from './fixtures/api';
import { socket } from '../lib/socket';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

function sendMessage(chatRoomId: string, text: string): Promise<Message> {
  return new Promise((resolve) => {
    socket.emit('chat:send', { chatRoomId, text, clientId: `client-${chatRoomId}` }, resolve);
  });
}

it('실제 목업에서 친구를 삭제하면 대화·시간표 공유를 지우고 재입장해도 복원하지 않는다', async () => {
  useNet.setState({ state: 'ok' });
  const friends = await mockApi.social.friends();
  const target = friends.find((friend) => friend.userId === 'u-jiwoo')!;
  const other = friends.find((friend) => friend.userId !== target.userId)!;
  expect(target).toBeDefined();
  const removedRoom = await mockApi.social.openDirect(target.userId);
  const keptRoom = await mockApi.social.openDirect(other.userId);
  expect((await mockApi.social.messages(removedRoom._id)).length).toBeGreaterThan(0);
  await sendMessage(removedRoom._id, '삭제해야 하는 실제 목업 대화');
  await sendMessage(keptRoom._id, '다른 친구의 보존할 대화');
  const keptMessages = await mockApi.social.messages(keptRoom._id);
  await mockApi.timetable.share({ friendIds: [other.userId], mode: 'free_only' });
  const beforeShares = await mockApi.timetable.shares();
  const keptShares = beforeShares.filter((share) => share.friendId === other.userId);
  expect(beforeShares.some((share) => share.friendId === target.userId)).toBe(true);
  expect(keptShares).toHaveLength(1);

  await mockApi.social.remove(target.userId);
  const afterFriends = await mockApi.social.friends();
  const removedMessages = await mockApi.social.messages(removedRoom._id);
  const reentered = await mockApi.social.openDirect(target.userId);
  const afterShares = await mockApi.timetable.shares();
  expect({
    targetFriend: afterFriends.find((friend) => friend.userId === target.userId),
    removedMessages,
    reenteredMessages: await mockApi.social.messages(reentered._id),
    targetShares: afterShares.filter((share) => share.friendId === target.userId),
    otherFriend: afterFriends.find((friend) => friend.userId === other.userId),
    otherMessages: await mockApi.social.messages(keptRoom._id),
    otherShares: afterShares.filter((share) => share.friendId === other.userId),
  }).toEqual({
    targetFriend: undefined,
    removedMessages: [],
    reenteredMessages: [],
    targetShares: [],
    otherFriend: other,
    otherMessages: keptMessages,
    otherShares: keptShares,
  });
});
