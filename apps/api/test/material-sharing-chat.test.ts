import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';

const owner = new Types.ObjectId().toHexString();
const room = new Types.ObjectId().toHexString();
const friend = new Types.ObjectId().toHexString();
const itemId = new Types.ObjectId();
const sharedId = new Types.ObjectId();
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });

function setup() {
  const materials = { find: vi.fn(), findOne: vi.fn() };
  const rooms = { exists: vi.fn().mockResolvedValue({ _id: room }) };
  const shared = { create: vi.fn(), findOne: vi.fn(), find: vi.fn() };
  const chat = {
    getDirectChat: vi.fn(),
    sendSharedItem: vi.fn(),
    sendDirectMaterial: vi.fn(),
    hasDirectMaterialAccess: vi.fn(),
    directSharedMaterial: vi.fn(),
    findSharedMessage: vi.fn(),
  };
  const gateway = { notifyStudyMessage: vi.fn(), notifyDirectMessage: vi.fn() };
  const quizzes = { findOne: vi.fn() };
  const cards = { findOne: vi.fn(), find: vi.fn() };
  const transaction = vi.fn((callback: (session: object) => Promise<unknown>) => callback({}));
  shared.findOne.mockReturnValue(lean(null));
  const service = new MaterialSharingService(
    materials as never,
    rooms as never,
    shared as never,
    {} as never,
    chat as never,
    gateway as never,
    quizzes as never,
    cards as never,
    { transaction } as never,
  );
  return { service, materials, rooms, shared, chat, gateway, quizzes, cards, transaction };
}

describe('채팅 학습 자료 공유', () => {
  it.each(['quiz', 'flashcards'] as const)(
    '%s는 소유권과 방 멤버십을 확인하고 해당 방 채팅으로 전송한다',
    async (kind) => {
      const x = setup();
      (kind === 'quiz' ? x.quizzes : x.cards).findOne.mockReturnValue(
        lean({ _id: itemId, title: '퀴즈' }),
      );
      x.shared.create.mockResolvedValue([{ _id: sharedId }]);
      x.chat.sendSharedItem.mockResolvedValue({ chatRoomId: 'chat' });
      await x.service.shareStudyItem(owner, room, kind, String(itemId), 'request-1');
      expect(x.shared.create).toHaveBeenCalledWith([expect.objectContaining({ itemType: kind, requestId: 'request-1' })], { session: expect.anything() });
      expect(x.chat.sendSharedItem).toHaveBeenCalledWith(
        room,
        owner,
        String(sharedId),
        kind === 'quiz' ? '퀴즈' : '플래시 카드',
        expect.anything(),
      );
      expect(x.gateway.notifyStudyMessage).toHaveBeenCalledWith({ chatRoomId: 'chat' });
    },
  );

  it('방 멤버가 아니거나 다른 사람의 퀴즈라면 저장하거나 전송하지 않는다', async () => {
    const x = setup();
    x.rooms.exists.mockResolvedValueOnce(null);
    await expect(
      x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1'),
    ).rejects.toMatchObject({ status: 404 });
    x.quizzes.findOne.mockReturnValue(lean(null));
    await expect(
      x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(x.shared.create).not.toHaveBeenCalled();
    expect(x.chat.sendSharedItem).not.toHaveBeenCalled();
  });

  it('메시지 저장이 실패하면 트랜잭션을 실패시키고 방송하지 않는다', async () => {
    const x = setup();
    x.quizzes.findOne.mockReturnValue(lean({ _id: itemId, title: '퀴즈' }));
    x.shared.create.mockResolvedValue([{ _id: sharedId }]);
    const failure = new Error('message write failed');
    x.chat.sendSharedItem.mockRejectedValue(failure);
    await expect(x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1')).rejects.toBe(failure);
    expect(x.transaction).toHaveBeenCalledTimes(1);
    expect(x.gateway.notifyStudyMessage).not.toHaveBeenCalled();
  });

  it('같은 요청을 재시도하면 기존 항목과 메시지를 사용한다', async () => {
    const x = setup();
    x.quizzes.findOne.mockReturnValue(lean({ _id: itemId, title: '퀴즈' }));
    x.shared.findOne.mockReturnValue(lean({ _id: sharedId, itemType: 'quiz', quizSetId: itemId }));
    x.chat.findSharedMessage.mockResolvedValue({ _id: 'message', chatRoomId: 'chat' });
    await x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1');
    expect(x.shared.create).not.toHaveBeenCalled();
    expect(x.chat.findSharedMessage).toHaveBeenCalledWith(room, owner, String(sharedId));
    expect(x.gateway.notifyStudyMessage).toHaveBeenCalledWith({ _id: 'message', chatRoomId: 'chat' });
  });

  it('중복 요청이 동시에 저장돼도 먼저 저장한 메시지를 재사용한다', async () => {
    const x = setup();
    x.quizzes.findOne.mockReturnValue(lean({ _id: itemId, title: '퀴즈' }));
    x.shared.findOne.mockReturnValueOnce(lean(null)).mockReturnValueOnce(lean({ _id: sharedId, itemType: 'quiz', quizSetId: itemId }));
    x.transaction.mockRejectedValueOnce({ code: 11000 });
    x.chat.findSharedMessage.mockResolvedValue({ _id: 'message', chatRoomId: 'chat' });
    await x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1');
    expect(x.chat.findSharedMessage).toHaveBeenCalledWith(room, owner, String(sharedId));
  });

  it('다른 자료에 같은 요청 식별자를 쓰면 거부한다', async () => {
    const x = setup();
    x.quizzes.findOne.mockReturnValue(lean({ _id: itemId, title: '퀴즈' }));
    x.shared.findOne.mockReturnValue(lean({ _id: sharedId, itemType: 'quiz', quizSetId: new Types.ObjectId() }));
    await expect(x.service.shareStudyItem(owner, room, 'quiz', String(itemId), 'request-1')).rejects.toMatchObject({ status: 409 });
    expect(x.gateway.notifyStudyMessage).not.toHaveBeenCalled();
  });

  it('친구에게 노트를 공유하면 1:1 채팅을 만들고 메시지를 알린다', async () => {
    const x = setup();
    x.materials.find.mockReturnValue(lean([{ _id: itemId, title: '필기' }]));
    x.chat.sendDirectMaterial.mockResolvedValue({ chatRoomId: 'direct' });
    await x.service.share(owner, {
      materialIds: [String(itemId)],
      target: { type: 'friend', id: friend },
    });
    expect(x.chat.getDirectChat).toHaveBeenCalledWith(owner, friend);
    expect(x.chat.sendDirectMaterial).toHaveBeenCalledWith(owner, friend, String(itemId), '필기');
    expect(x.gateway.notifyDirectMessage).toHaveBeenCalledWith({ chatRoomId: 'direct' });
    expect(x.shared.create).not.toHaveBeenCalled();
  });

  it('공유 항목을 열 때 현재 멤버가 아니거나 삭제된 자료면 거부한다', async () => {
    const x = setup();
    x.rooms.exists.mockResolvedValueOnce(null);
    await expect(x.service.findRoomItem(owner, room, String(sharedId))).rejects.toMatchObject({
      status: 404,
    });
    expect(x.shared.findOne).not.toHaveBeenCalled();
    x.shared.findOne.mockReturnValue(lean({ itemType: 'material', materialId: itemId }));
    x.materials.findOne.mockReturnValue(lean(null));
    await expect(x.service.findRoomItem(owner, room, String(sharedId))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('방 참가자는 공유된 카드의 앞뒷면을 읽을 수 있다', async () => {
    const x = setup();
    x.shared.findOne.mockReturnValue(lean({ itemType: 'flashcards', flashcardIds: [itemId] }));
    x.cards.find.mockReturnValue(lean([{ front: '문제', back: '정답' }]));
    await expect(x.service.findRoomItem(owner, room, String(sharedId))).resolves.toEqual({
      itemType: 'flashcards',
      cards: [{ front: '문제', back: '정답' }],
    });
  });
});
