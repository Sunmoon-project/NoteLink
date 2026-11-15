import { Injectable } from '@nestjs/common';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  channelId: string;
  collapseId: string;
  threadId: string;
}

type ExpoPushTicket = {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};

export type ExpoPushResult = {
  invalidTokens: string[];
  failedTickets: { token: string; error: string }[];
};

/** Expo Push Service를 통해 APNs·FCM으로 푸시를 보낸다. */
@Injectable()
export class ExpoPushService {
  async send(messages: ExpoPushMessage[]): Promise<ExpoPushResult> {
    const result: ExpoPushResult = { invalidTokens: [], failedTickets: [] };
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000),
      });
      const responseBody = (await response.json().catch(() => null)) as {
        data?: ExpoPushTicket[];
        errors?: { message?: string }[];
      } | null;
      if (!response.ok || !Array.isArray(responseBody?.data)) {
        throw new Error(`Expo Push Service 요청 실패 (${response.status})`);
      }
      if (responseBody.errors?.length) throw new Error('Expo Push Service가 요청을 거부했습니다');

      if (responseBody.data.length !== batch.length) {
        throw new Error('Expo Push Service 응답의 ticket 수가 요청과 일치하지 않습니다');
      }

      responseBody.data.forEach((ticket, index) => {
        if (ticket.status !== 'error') return;
        const token = batch[index]!.to;
        if (ticket.details?.error === 'DeviceNotRegistered') {
          result.invalidTokens.push(token);
          return;
        }
        result.failedTickets.push({
          token,
          error: ticket.details?.error ?? 'unknown',
        });
      });
    }
    return result;
  }
}
