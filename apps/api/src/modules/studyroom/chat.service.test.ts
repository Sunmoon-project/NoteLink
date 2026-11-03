import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatRoom } from '../social/schemas/chat-room.schema.js';
import { Message } from '../social/schemas/message.schema.js';
import { ChatService } from './chat.service.js';
import { StudyRoom } from './schemas/study-room.schema.js';

describe('ChatService', () => {
  let service: ChatService;
  let studyRoomModel: { findById: ReturnType<typeof vi.fn> };
  let chatRoomModel: {
    findOne: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let messageModel: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };

  const userId = new Types.ObjectId().toString();
  const roomId = new Types.ObjectId().toString();

  beforeEach(async () => {
    studyRoomModel = { findById: vi.fn() };
    chatRoomModel = { findOne: vi.fn(), findOneAndUpdate: vi.fn(), findById: vi.fn() };
    messageModel = { create: vi.fn(), find: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getModelToken(StudyRoom.name), useValue: studyRoomModel },
        { provide: getModelToken(ChatRoom.name), useValue: chatRoomModel },
        { provide: getModelToken(Message.name), useValue: messageModel },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
  });

  describe('assertMember', () => {
    it('없는 방이면 ROOM_NOT_FOUND', async () => {
      studyRoomModel.findById.mockResolvedValue(null);
      await expect(service.assertMember(userId, roomId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('참여 멤버가 아니면 NOT_A_MEMBER(Forbidden)', async () => {
      studyRoomModel.findById.mockResolvedValue({
        closedAt: undefined,
        members: [
          {
            userId: new Types.ObjectId(), // 다른 사람
            status: 'joined',
          },
        ],
      });
      await expect(service.assertMember(userId, roomId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('참여 멤버면 통과한다', async () => {
      studyRoomModel.findById.mockResolvedValue({
        closedAt: undefined,
        members: [{ userId: new Types.ObjectId(userId), status: 'joined' }],
      });
      await expect(service.assertMember(userId, roomId)).resolves.toBeUndefined();
    });
  });

  describe('saveMessage', () => {
    it('메시지를 저장하고 방송용 뷰를 돌려준다', async () => {
      const now = new Date();
      const chatRoomSave = vi.fn().mockResolvedValue(undefined);
      chatRoomModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(),
        save: chatRoomSave,
      });
      const msgId = new Types.ObjectId();
      messageModel.create.mockResolvedValue({
        _id: msgId,
        chatRoomId: new Types.ObjectId(),
        senderId: new Types.ObjectId(userId),
        type: 'text',
        text: '안녕하세요',
        get: (key: string) => (key === 'createdAt' ? now : undefined),
      });

      const result = await service.saveMessage(userId, roomId, '안녕하세요', 'c1');

      expect(messageModel.create).toHaveBeenCalledOnce();
      expect(chatRoomSave).toHaveBeenCalledOnce(); // lastMessage 갱신 저장
      expect(result._id).toBe(msgId.toString());
      expect(result.clientId).toBe('c1');
      expect(result.text).toBe('안녕하세요');
      expect(result.senderId).toBe(userId);
      expect(result.createdAt).toBe(now.toISOString());
    });

    it('채팅방 생성이 동시에 일어나 유일 인덱스에 걸리면 다시 읽는다', async () => {
      const id = new Types.ObjectId();
      chatRoomModel.findOneAndUpdate
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }))
        .mockResolvedValueOnce({ _id: id });

      await expect(service.getChatRoomId(roomId)).resolves.toBe(id.toString());
      expect(chatRoomModel.findOneAndUpdate.mock.calls[0]?.[2]).toMatchObject({ upsert: true });
    });
  });

  describe('getHistory', () => {
    // find().sort().limit().exec() 체인 헬퍼
    function mockFindChain(result: unknown[]) {
      const chain = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(result),
      };
      messageModel.find.mockReturnValue(chain);
      return chain;
    }

    it('연결된 chat_room이 없으면 빈 배열', async () => {
      chatRoomModel.findOne.mockResolvedValue(null);
      const result = await service.getHistory(roomId);
      expect(result).toEqual([]);
    });

    it('_id 기준 최신순으로 집어 오래된→최신 순으로 뒤집어 반환한다', async () => {
      chatRoomModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });
      const now = new Date();
      const mk = (text: string) => ({
        _id: new Types.ObjectId(),
        chatRoomId: new Types.ObjectId(),
        senderId: new Types.ObjectId(),
        type: 'text',
        text,
        get: () => now,
      });
      // DB는 최신순(newest first)으로 돌려줌
      const chain = mockFindChain([mk('두번째'), mk('첫번째')]);

      const result = await service.getHistory(roomId, { limit: 2 });

      expect(chain.sort).toHaveBeenCalledWith({ _id: -1 }); // 안정 정렬
      expect(chain.limit).toHaveBeenCalledWith(2);
      // 반환은 오래된→최신 (뒤집힘)
      expect(result.map((m) => m.text)).toEqual(['첫번째', '두번째']);
    });

    it('before 커서를 주면 그 id보다 이전만 조회한다', async () => {
      chatRoomModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });
      mockFindChain([]);
      const cursor = new Types.ObjectId().toString();

      await service.getHistory(roomId, { before: cursor });

      const filterArg = messageModel.find.mock.calls[0]?.[0] as {
        _id?: { $lt: Types.ObjectId };
      };
      expect(filterArg._id).toBeDefined();
      expect(filterArg._id!.$lt.toString()).toBe(cursor);
    });

    it('limit은 최대 100으로 제한한다', async () => {
      chatRoomModel.findOne.mockResolvedValue({ _id: new Types.ObjectId() });
      const chain = mockFindChain([]);

      await service.getHistory(roomId, { limit: 9999 });

      expect(chain.limit).toHaveBeenCalledWith(100);
    });
  });

  describe('studyRoomOf', () => {
    it('스터디룸 채팅이 아니면 ROOM_NOT_FOUND', async () => {
      chatRoomModel.findById.mockResolvedValue({ _id: new Types.ObjectId() });
      await expect(service.studyRoomOf(new Types.ObjectId().toString())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
