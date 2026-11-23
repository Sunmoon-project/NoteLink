import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { markNotificationRead } from './index';
import { openRoute, routeFor } from '@/lib/notification-route';
import { queryClient } from '@/lib/query';

/** 이미 처리한 알림(앱이 꺼진 채 알림으로 열렸을 때 다시 그려도 같은 알림으로 또 가지 않게) */
const handled = new Set<string>();

function open(r: Notifications.NotificationResponse | null) {
  if (!r) return;
  const id = r.notification.request.identifier;
  if (handled.has(id)) return;
  handled.add(id);
  const data = r.notification.request.content.data as Record<string, unknown> | undefined;
  const notificationId = typeof data?.notificationId === 'string' ? data.notificationId : null;
  if (notificationId) markNotificationRead(notificationId);
  else void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const to = routeFor(data);
  if (to) openRoute(to);
}

/** 푸시를 누르면 그 화면으로 · 알림함 읽음 처리. 앱이 앞에 있을 때 알림이 오면 읽지 않은 수를 새로 읽는다 */
export function usePushTaps(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    void Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => {});
    const tap = Notifications.addNotificationResponseReceivedListener(open);
    const received = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });
    return () => {
      tap.remove();
      received.remove();
    };
  }, [signedIn]);
}
