import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { useSession } from '@/stores/session';
import { toast } from '@/stores/toast';
import { useNow } from '@/hooks';
import { seoul, ymd } from '@/lib/dates';

const KIND = 'weekly-goal-80';
type Reservation = { id: string; dueAt: number; sessionId: string; targetMin: number };
let queue: Promise<void> = Promise.resolve();
const enqueue = (work: () => Promise<void>) => {
  queue = queue.catch(() => {}).then(work);
  return queue;
};
const keyFor = (userId: string, week: string) => `weekly80.${userId}.${week}`;

/** 앱이 잠겨도 OS가 예정된 시각에 알린다. 확인은 사용자가 직접 누른 뒤에만 서버에 기록한다. */
export function WeeklyGoalNotifications() {
  const userId = useAuth((s) => s.userId);
  const token = useAuth((s) => s.tokens?.accessToken);
  const session = useSession();
  const qc = useQueryClient();
  const active = !!userId && !!token;
  const day = ymd(seoul(useNow(true, 60_000)));
  const goal = useQuery({
    queryKey: ['goal', 'weekly', 'notification', userId, day],
    queryFn: api.study.weeklyGoal,
    enabled: active,
  });
  const weekly = useQuery({
    queryKey: ['study', 'weekly', 'notification', userId, day],
    queryFn: api.study.weekly,
    enabled: active,
  });
  const shown = useRef(false);
  const previousOwner = useRef<{ userId: string; week: string } | null>(null);

  useEffect(() => {
    const previous = previousOwner.current;
    if (previous && (!active || previous.userId !== userId)) {
      void enqueue(async () => {
        const key = keyFor(previous.userId, previous.week);
        const raw = await SecureStore.getItemAsync(key);
        if (!raw) return;
        const saved = JSON.parse(raw) as Reservation;
        if (saved.dueAt > Date.now()) {
          await Notifications.cancelScheduledNotificationAsync(saved.id);
          await SecureStore.deleteItemAsync(key);
        }
      }).catch(() => toast('주간 목표 알림을 취소하지 못했어요'));
      previousOwner.current = null;
    }
    if (active && userId && goal.data)
      previousOwner.current = { userId, week: goal.data.weekStart };
  }, [active, userId, goal.data]);

  useEffect(() => {
    if (
      !active ||
      !userId ||
      !goal.data ||
      !weekly.data ||
      goal.data.weekStart !== weekly.data.weekStart
    )
      return;
    const g = goal.data;
    const week = g.weekStart;
    const owner = userId;
    let cancelled = false;
    void enqueue(async () => {
      const key = keyFor(owner, week);
      let saved: Reservation | null = null;
      try {
        saved = JSON.parse((await SecureStore.getItemAsync(key)) ?? 'null') as Reservation | null;
      } catch {
        /* 새로 예약한다 */
      }
      if (cancelled) return;
      const now = Date.now();
      // 예정 시각이 지난 예약은 이미 알렸을 수 있다. 확인 전 앱 재진입으로 반복 발송하지 않는다.
      if (saved && saved.dueAt <= now && !g.notified80) return;
      const enabled =
        g.notify80 && !g.notified80 && g.targetMin > 0 && !!session.sessionId && !!session.since;
      const start = Date.parse(`${week}T00:00:00+09:00`);
      const elapsed = session.elapsedSince(start, now);
      const remaining = Math.max(0, g.targetMin * 60 * 0.8 - (weekly.data!.totalSec + elapsed));
      const dueAt = now + Math.max(1000, Math.ceil(remaining * 1000));
      const inWeek = dueAt < start + 7 * 24 * 3600 * 1000;
      if (
        saved &&
        enabled &&
        inWeek &&
        saved.sessionId === session.sessionId &&
        saved.targetMin === g.targetMin &&
        Math.abs(saved.dueAt - dueAt) < 2000
      )
        return;
      if (saved) {
        await Notifications.cancelScheduledNotificationAsync(saved.id);
        await SecureStore.deleteItemAsync(key);
      }
      if (cancelled || !enabled || !inWeek) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted || cancelled) return;
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: '이번 주 목표 80% 달성',
          body: '이번 주 공부 목표의 80%를 달성했어요.',
          data: { kind: KIND, weekStart: week, userId: owner },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(dueAt) },
      });
      if (cancelled) {
        await Notifications.cancelScheduledNotificationAsync(id);
        return;
      }
      try {
        await SecureStore.setItemAsync(
          key,
          JSON.stringify({ id, dueAt, sessionId: session.sessionId, targetMin: g.targetMin }),
        );
      } catch (error) {
        await Notifications.cancelScheduledNotificationAsync(id);
        throw error;
      }
    }).catch(() => toast('주간 목표 알림을 예약하지 못했어요'));
    return () => {
      cancelled = true;
    };
  }, [
    active,
    userId,
    goal.data,
    weekly.data,
    session,
  ]);

  useEffect(() => {
    if (!active || !userId) return;
    const show = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      if (
        data?.kind !== KIND ||
        data.userId !== userId ||
        typeof data.weekStart !== 'string' ||
        shown.current
      )
        return;
      const week = data.weekStart;
      shown.current = true;
      Alert.alert('주간 목표 80% 달성', '이번 주 공부 목표의 80%를 달성했어요.', [
        {
          text: '나중에',
          style: 'cancel',
          onPress: () => {
            shown.current = false;
          },
        },
        {
          text: '확인',
          onPress: () => {
            if (useAuth.getState().userId !== userId || !useAuth.getState().tokens) {
              shown.current = false;
              return;
            }
            void api.study
              .acknowledgeWeeklyGoal(week)
              .then(async () => {
                await Notifications.clearLastNotificationResponseAsync();
                await qc.invalidateQueries({ queryKey: ['goal', 'weekly'] });
              })
              .catch(() => toast('알림 확인을 저장하지 못했어요. 다시 시도해주세요'))
              .finally(() => {
                shown.current = false;
              });
          },
        },
      ]);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(show);
    void Notifications.getLastNotificationResponseAsync().then(show);
    return () => sub.remove();
  }, [active, userId, qc]);
  return null;
}
