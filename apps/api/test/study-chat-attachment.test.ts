import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

// 실기기 테스트: 스터디룸 채팅의 + 로 사진 · 파일을 보내고 싶다고 함
const me = new Types.ObjectId();
const chatId = new Types.ObjectId();
const blobUrl = `https://store/raw/chat/image/${String(me)}/0b8c5f3e-1d2a-4c1b-9a7e-5d6f7a8b9c0d.jpg`;
const leanResult = (value: unknown) => ({ lean: () => ({ orFail: async () => value }) });

function setup(over: { stored?: Record<string, unknown>; signFails?: boolean } = {}) {
  const stored = {
    _id: new Types.ObjectId(),
    chatRoomId: chatId,
    senderId: me,
    type: 'image',
    text: null,
    clientId: 'c1',
    attachment: { blobUrl, name: '필기.jpg', sizeBytes: 2048 },
    createdAt: new Date('2026-11-18T00:00:00Z'),
    ...over.stored,
  };
  const messages = { findOneAndUpdate: vi.fn().mockReturnValue(leanResult(stored)) };
  const users = { findById: vi.fn().mockReturnValue({ lean: async () => ({ nickname: '나' }) }) };
  const blobs = {
    createReadAccess: vi.fn(
      async (
        _url: string,
        _ttl: number,
        verify?: { prefix: string },
      ): Promise<{ readUrl: string; sizeBytes?: number; contentType?: string | null }> => {
        if (over.signFails && !verify) throw new Error('sign');
        return verify
          ? {
              readUrl: 'x',
              sizeBytes: 2048,
              contentType: _url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
            }
          : { readUrl: `${_url}?sig` };
      },
    ),
  };
  const service = new StudyChatService(
    {} as never,
    {} as never,
    messages as never,
    users as never,
    {} as never,
    blobs as never,
  );
  vi.spyOn(service, 'requireChat').mockResolvedValue({} as never);
  return { service, messages, blobs };
}

describe('스터디룸 채팅 사진 · 파일 메시지', () => {
  it('보낸 사람 본인의 채팅 경로에 실제로 있는 파일만 받아 저장하고, 잠깐 읽을 수 있는 주소로 돌려준다', async () => {
    const { service, messages, blobs } = setup();

    const sent = await service.sendAttachment(
      String(chatId),
      String(me),
      { blobUrl, kind: 'image', name: ' 필기.jpg ' },
      'c1',
    );

    expect(blobs.createReadAccess).toHaveBeenCalledWith(blobUrl, expect.any(Number), {
      prefix: `chat/image/${String(me)}/`,
    });
    expect(messages.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1' }),
      {
        $setOnInsert: expect.objectContaining({
          type: 'image',
          text: null,
          attachment: { blobUrl, name: '필기.jpg', sizeBytes: 2048 },
        }),
      },
      expect.objectContaining({ upsert: true }),
    );
    expect(sent.attachment).toEqual({
      kind: 'image',
      name: '필기.jpg',
      sizeBytes: 2048,
      url: `${blobUrl}?sig`,
    });
  });

  it('파일(PDF)은 문서 채팅 경로에서 확인한다', async () => {
    const fileUrl = blobUrl.replace('/image/', '/document/').replace('.jpg', '.pdf');
    const { service, blobs } = setup({
      stored: { type: 'file', attachment: { blobUrl: fileUrl, name: '요약.pdf', sizeBytes: 9 } },
    });
    await service.sendAttachment(
      String(chatId),
      String(me),
      { blobUrl: fileUrl, kind: 'file', name: '요약.pdf' },
      'c1',
    );
    expect(blobs.createReadAccess).toHaveBeenCalledWith(fileUrl, expect.any(Number), {
      prefix: `chat/document/${String(me)}/`,
    });
  });

  it.each([
    ['녹음 종류', { blobUrl, kind: 'audio', name: 'a.m4a' }, 'c1'],
    ['이름 없음', { blobUrl, kind: 'image', name: ' ' }, 'c1'],
    ['주소 없음', { kind: 'image', name: 'a.jpg' }, 'c1'],
    ['잘못된 clientId', { blobUrl, kind: 'image', name: 'a.jpg' }, '공백 있는 id'],
  ])('%s이면 400이고 파일을 확인하지도 않는다', async (_, attachment, clientId) => {
    const { service, blobs } = setup();
    await expect(
      service.sendAttachment(String(chatId), String(me), attachment, clientId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(blobs.createReadAccess).not.toHaveBeenCalled();
  });

  it('남의 폴더 · 없는 파일이라 확인에 실패하면 저장하지 않는다', async () => {
    const { service, messages, blobs } = setup();
    blobs.createReadAccess.mockRejectedValueOnce(
      new BadRequestException('사용할 수 없는 파일 주소예요'),
    );
    await expect(
      service.sendAttachment(
        String(chatId),
        String(me),
        { blobUrl, kind: 'image', name: 'a.jpg' },
        'c1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(messages.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // Codex #507 리뷰: 올리기 주소는 앱이 알린 크기로만 내주므로, 실제 크기가 상한을 넘는 파일은 여기서 막는다
  it.each([
    ['사진', 'image', 50 * 1024 * 1024],
    ['파일', 'file', 100 * 1024 * 1024],
  ] as const)(
    '실제로 올라간 %s이 상한(%d바이트)을 넘으면 저장하지 않는다',
    async (_, kind, max) => {
      const { service, messages, blobs } = setup();
      blobs.createReadAccess.mockResolvedValueOnce({
        readUrl: 'x',
        sizeBytes: max + 1,
        contentType: 'image/jpeg',
      });
      await expect(
        service.sendAttachment(String(chatId), String(me), { blobUrl, kind, name: 'big' }, 'c1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messages.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  // 실기기 테스트: 채팅 첨부는 노트 상한(사진 20MB · PDF 50MB)보다 크게 받는다
  it('노트 상한보다 큰 채팅 첨부(사진 30MB · 파일 80MB)도 보낸다', async () => {
    for (const [kind, size] of [
      ['image', 30 * 1024 * 1024],
      ['file', 80 * 1024 * 1024],
    ] as const) {
      const { service, messages, blobs } = setup({ stored: { type: kind } });
      blobs.createReadAccess.mockResolvedValueOnce({
        readUrl: 'x',
        sizeBytes: size,
        contentType: 'image/jpeg',
      });
      await service.sendAttachment(
        String(chatId),
        String(me),
        { blobUrl, kind, name: 'big' },
        'c1',
      );
      expect(messages.findOneAndUpdate).toHaveBeenCalled();
    }
  });

  // Codex #519 리뷰: 올리기 주소와 다른 형식(text/html)으로 직접 올려도 첨부로 저장돼 브라우저에서 열렸다
  it.each([['text/html'], [null]])(
    '저장된 형식이 확장자와 다르면(%s) 저장하지 않는다',
    async (type) => {
      const { service, messages, blobs } = setup();
      blobs.createReadAccess.mockResolvedValueOnce({
        readUrl: 'x',
        sizeBytes: 10,
        contentType: type,
      });
      await expect(
        service.sendAttachment(
          String(chatId),
          String(me),
          { blobUrl, kind: 'image', name: 'a' },
          'c1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messages.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('같은 clientId로 다른 파일을 보내면 400(이미 쓴 식별자)', async () => {
    const { service } = setup({
      stored: { attachment: { blobUrl: 'other', name: 'b', sizeBytes: 1 } },
    });
    await expect(
      service.sendAttachment(
        String(chatId),
        String(me),
        { blobUrl, kind: 'image', name: 'a.jpg' },
        'c1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('읽기 주소를 만들지 못하면 첨부 없이 메시지를 돌려준다(기록 조회가 통째로 실패하지 않게)', async () => {
    const { service } = setup({ signFails: true });
    const sent = await service.sendAttachment(
      String(chatId),
      String(me),
      { blobUrl, kind: 'image', name: 'a.jpg' },
      'c1',
    );
    expect(sent.type).toBe('image');
    expect(sent).not.toHaveProperty('attachment');
  });
});
