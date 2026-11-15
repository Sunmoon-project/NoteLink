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
type ExpoPushResponse = {
  data?: ExpoPushTicket[];
  errors?: { message?: string }[];
};

export type ExpoPushResult = {
  invalidTokens: string[];
  failedTickets: { message: ExpoPushMessage; error: string }[];
};

/** Expo Push Service를 통해 APNs·FCM으로 푸시를 보낸다. */
@Injectable()
export class ExpoPushService {
  async send(messages: ExpoPushMessage[]): Promise<ExpoPushResult> {
    const result: ExpoPushResult = { invalidTokens: [], failedTickets: [] };
    for (let offset = 0; offset < messages.length; offset += 100) {
      const batch = messages.slice(offset, offset + 100);
      let response: Response | null = null;
      let responseBody: ExpoPushResponse | null = null;
      try {
        response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(10_000),
        });
        responseBody = (await response.json().catch(() => null)) as ExpoPushResponse | null;
      } catch {
        for (const message of batch)
          result.failedTickets.push({ message, error: 'Expo Push Service 연결 실패' });
        continue;
      }

      const requestError = !response.ok
        ? `Expo Push Service HTTP ${response.status}`
        : responseBody?.errors?.length
          ? responseBody.errors[0]?.message || 'Expo Push Service가 배치를 거부했습니다'
          : !Array.isArray(responseBody?.data)
            ? 'Expo Push Service 응답 형식 오류'
            : null;
      if (requestError) {
        for (const message of batch) result.failedTickets.push({ message, error: requestError });
        continue;
      }
      if (responseBody!.data!.length !== batch.length) {
        for (const message of batch)
          result.failedTickets.push({ message, error: 'Expo ticket 수 불일치' });
        continue;
      }

      responseBody!.data!.forEach((ticket, index) => {
        if (ticket.status !== 'error') return;
        const message = batch[index]!;
        if (ticket.details?.error === 'DeviceNotRegistered') {
          result.invalidTokens.push(message.to);
          return;
        }
        result.failedTickets.push({
          message,
          error: ticket.details?.error ?? 'unknown',
        });
      });
    }
    return result;
  }
}
