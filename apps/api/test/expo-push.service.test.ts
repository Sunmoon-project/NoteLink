import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from '../src/modules/notification/expo-push.service.js';
import { ExpoPushService } from '../src/modules/notification/expo-push.service.js';

const fetchMock = vi.fn();

const message = (token: string): ExpoPushMessage => ({
  to: token,
  title: '스터디룸 타이머',
  body: '집중 시간이 끝났어요.',
  data: { type: 'study-room-timer' },
  sound: 'default',
  priority: 'high',
  channelId: 'study-room-timer',
  collapseId: 'room:transition',
  threadId: 'study-room-room',
});

const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExpoPushService', () => {
  it('한 요청에 최대 100개씩 나누고 모든 ticket 성공을 반환한다', async () => {
    const messages = Array.from({ length: 101 }, (_, index) => message(`token-${index}`));
    fetchMock
      .mockResolvedValueOnce(
        response({ data: Array.from({ length: 100 }, () => ({ status: 'ok' })) }),
      )
      .mockResolvedValueOnce(response({ data: [{ status: 'ok' }] }));
    const service = new ExpoPushService();

    await expect(service.send(messages)).resolves.toEqual({ invalidTokens: [], failedTickets: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toHaveLength(1);
  });

  it('기기별 ticket 오류를 분리해 성공 기기와 무효 토큰에 섞지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        data: [
          { status: 'ok', id: 'ticket-1' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
          { status: 'error', details: { error: 'MessageRateExceeded' } },
        ],
      }),
    );
    const service = new ExpoPushService();

    await expect(
      service.send([message('success-token'), message('invalid-token'), message('retry-token')]),
    ).resolves.toEqual({
      invalidTokens: ['invalid-token'],
      failedTickets: [{ token: 'retry-token', error: 'MessageRateExceeded' }],
    });
  });

  it('요청 전체 오류나 ticket 수 불일치는 개별 결과로 오인하지 않고 실패 처리한다', async () => {
    const service = new ExpoPushService();
    fetchMock.mockResolvedValueOnce(response({ errors: [{ message: 'rate limited' }] }, 429));
    await expect(service.send([message('token-1')])).rejects.toThrow(
      'Expo Push Service 요청 실패 (429)',
    );

    fetchMock.mockResolvedValueOnce(response({ data: [] }));
    await expect(service.send([message('token-1')])).rejects.toThrow(
      'ticket 수가 요청과 일치하지 않습니다',
    );
  });
});
