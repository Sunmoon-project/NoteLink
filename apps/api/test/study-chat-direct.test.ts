import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const me = new Types.ObjectId();
const friend = new Types.ObjectId();
const directChat = { _id: new Types.ObjectId(), type: 'direct' };
const leanResult = (value: unknown) => ({ lean: () => ({ orFail: async () => value }) });

function setup(isFriend = true) {
  const chats = {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn().mockReturnValue(leanResult(directChat)),
    updateOne: vi.fn(),
  };
  const messages = {
    findOneAndUpdate: vi.fn().mockReturnValue(
      leanResult({
        _id: new Types.ObjectId(),
        chatRoomId: directChat._id,
        senderId: me,
        type: 'study_room_invite',
        text: '함께 공부방 스터디룸에 초대했어요.',
        studyRoomInvite: {
          roomId: '64b000000000000000000001',
          title: '함께 공부방',
          inviteCode: 'AB12CD',
        },
        createdAt: new Date('2026-11-14T00:00:00Z'),
      }),
    ),
  };
  const users = {
    countDocuments: vi.fn().mockResolvedValue(2),
    findById: vi.fn().mockReturnValue({ lean: async () => ({ nickname: '초대한 사람' }) }),
  };
  const friendships = {
    exists: vi.fn().mockResolvedValue(isFriend ? { _id: new Types.ObjectId() } : null),
  };
  return {
    chats,
    messages,
    friendships,
    service: new StudyChatService(
      {} as never,
      chats as never,
      messages as never,
      users as never,
      friendships as never,
    ),
  };
}

describe('1:1 채팅 스터디룸 초대 메시지', () => {
  it('친구 채팅을 만들거나 찾고 참여 가능한 초대 카드를 메시지로 저장한다', async () => {
    const { service, chats, messages } = setup();
    const invite = { _id: '64b000000000000000000001', title: '함께 공부방', inviteCode: 'AB12CD' };

    const sent = await service.sendRoomInvite(String(me), String(friend), invite);

    expect(chats.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ directKey: expect.stringMatching(/^[a-f0-9]{24}:[a-f0-9]{24}$/) }),
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ type: 'direct' }) }),
      expect.objectContaining({ upsert: true }),
    );
    expect(messages.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ chatRoomId: directChat._id, senderId: me }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          type: 'study_room_invite',
          studyRoomInvite: {
            roomId: invite._id,
            title: invite.title,
            inviteCode: invite.inviteCode,
          },
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(sent).toMatchObject({
      type: 'study_room_invite',
      studyRoomInvite: { roomId: invite._id, title: invite.title, inviteCode: invite.inviteCode },
    });
  });

  it('친구 관계가 없는 사용자에게는 DM을 만들지 않는다', async () => {
    const { service, chats } = setup(false);
    await expect(service.getDirectChat(String(me), String(friend))).rejects.toMatchObject({
      status: 404,
    });
    expect(chats.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('requireChat은 실제 DM 멤버십과 현재 친구 관계를 모두 확인한다', async () => {
    const { service, chats, friendships } = setup();
    const chatId = new Types.ObjectId();
    const members = [
      { userId: me, leftAt: null },
      { userId: friend, leftAt: null },
    ];
    chats.findOne.mockReturnValue({ lean: async () => ({ _id: chatId, type: 'direct', members }) });

    await expect(service.requireChat(String(chatId), String(me))).resolves.toMatchObject({
      type: 'direct',
    });
    await expect(service.requireChat(String(chatId), String(new Types.ObjectId()))).rejects.toMatchObject({
      status: 404,
    });

    friendships.exists.mockResolvedValueOnce(null);
    await expect(service.requireChat(String(chatId), String(me))).rejects.toMatchObject({
      status: 404,
    });
    expect(friendships.exists).toHaveBeenCalledWith({
      userA: expect.any(Types.ObjectId),
      userB: expect.any(Types.ObjectId),
      status: 'accepted',
    });
  });
});
