import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const chatId = new Types.ObjectId();
const userId = new Types.ObjectId();
const friendId = new Types.ObjectId();
const sharedId = new Types.ObjectId();
const materialId = new Types.ObjectId();
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });

function setup() {
  const chats = { findOne: vi.fn(), updateOne: vi.fn() };
  const messages = { findOne: vi.fn(), find: vi.fn(), create: vi.fn() };
  const friendships = { exists: vi.fn() };
  const service = new StudyChatService(
    {} as never,
    chats as never,
    messages as never,
    {} as never,
    friendships as never,
  );
  const direct = {
    _id: chatId,
    type: 'direct',
    members: [
      { userId, leftAt: null },
      { userId: friendId, leftAt: null },
    ],
  };
  chats.findOne.mockReturnValue(lean(direct));
  friendships.exists.mockResolvedValue({});
  return { service, chats, messages, friendships };
}

describe('1:1 공유 자료 권한', () => {
  it('현재 친구 관계의 채팅 참여자에게만 메시지의 자료 ID를 반환한다', async () => {
    const x = setup();
    x.messages.findOne.mockReturnValue(lean({ sharePreview: { materialId: String(materialId) } }));
    await expect(
      x.service.directSharedMaterial(String(userId), String(chatId), String(sharedId)),
    ).resolves.toBe(String(materialId));
    expect(x.messages.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ chatRoomId: chatId, sharedItemId: sharedId, deletedAt: null }),
    );
    x.friendships.exists.mockResolvedValue(null);
    await expect(
      x.service.directSharedMaterial(String(userId), String(chatId), String(sharedId)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('채팅 참여자가 아닌 사용자와 잘못된 공유 ID를 거부한다', async () => {
    const x = setup();
    await expect(
      x.service.directSharedMaterial(
        String(new Types.ObjectId()),
        String(chatId),
        String(sharedId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      x.service.directSharedMaterial(String(userId), String(chatId), 'bad-id'),
    ).rejects.toMatchObject({ status: 404 });
    expect(x.messages.findOne).not.toHaveBeenCalled();
  });

  it('친구 관계가 끝난 공유는 노트 접근 권한을 주지 않는다', async () => {
    const x = setup();
    x.messages.find.mockReturnValue(lean([{ chatRoomId: chatId }]));
    x.friendships.exists.mockResolvedValue(null);
    expect(await x.service.hasDirectMaterialAccess(String(userId), String(materialId))).toBe(false);
  });
});
