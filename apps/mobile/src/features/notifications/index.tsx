import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Bell } from 'lucide-react-native';
import type { Notification, UserSettings } from '@notelink/shared';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import {
  Alert,
  Canvas,
  Empty,
  Group,
  Header,
  Label,
  Loading,
  Row,
  Screen,
  Sheet,
  SwipeAction,
  Toggle,
  cx,
} from '@/components/ui';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { timeAgo } from '@/lib/dates';
import { openRoute, routeFor } from '@/lib/notification-route';
import { LoadError } from '@/features/progress/load-error';
import { toast } from '@/stores/toast';
import { C, ICON } from '@/theme';

/** 홈 종 아이콘의 읽지 않은 수 · 알림함이 같이 쓰는 키 */
export const UNREAD_KEY = ['notifications', 'unread'] as const;
const LIST_KEY = ['notifications', 'list'] as const;
const REMOVE_KEY = ['notifications', 'remove'] as const;
type InboxPages = { pages: { items: Notification[] }[] };

/** 서버는 AI 작업 알림 등을 알림함에 1분 주기로 쌓는다(ai-job-notices NOTICE_SCAN_MS). 푸시를 못 받는 기기에서도 늦지 않게 */
export const UNREAD_REFETCH_MS = 60_000;

/** 읽지 않은 알림 수(홈 종 아이콘). 보고 있는 동안 주기적으로 다시 읽는다(TestQA PROF-007) */
export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => api.notifications.unreadCount(),
    refetchInterval: UNREAD_REFETCH_MS,
  });
}

/** 읽음 처리가 끝난 뒤에(실패해도) 알림함 · 읽지 않은 수를 다시 읽는다 */
export function markNotificationRead(id: string, qc: QueryClient = queryClient) {
  void api.notifications
    .markRead(id)
    .catch(() => {})
    .finally(() => void qc.invalidateQueries({ queryKey: ['notifications'] }));
}

/** 알림을 눌렀을 때: 읽음 처리(실패해도 이동은 한다) 뒤 그 화면으로 */
export function openNotification(
  n: Pick<Notification, '_id' | 'type' | 'data' | 'readAt'>,
  qc?: QueryClient,
) {
  if (!n.readAt) markNotificationRead(n._id, qc);
  // 알림함은 type을 data 밖에 둔다(푸시 data에는 같이 들어 있다)
  const to = routeFor({ ...n.data, type: n.type });
  if (to) openRoute(to);
}

export function InboxScreen() {
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam }) => api.notifications.list(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const readAll = useMutation({
    mutationFn: api.notifications.readAll,
    onSuccess: refresh,
    onError: () => toast('읽음 처리를 하지 못했어요. 다시 시도해 주세요'),
  });
  // 옆으로 밀어 「삭제」를 누르면 바로, 꾹 누르면 한 번 묻고 지운다. 목록에서 먼저 빼고 실패하면 다시 읽는다
  const [removing, setRemoving] = useState<Notification | null>(null);
  const remove = useMutation({
    mutationKey: REMOVE_KEY,
    mutationFn: (id: string) => api.notifications.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: LIST_KEY });
      const before = qc.getQueryData<InboxPages>(LIST_KEY);
      qc.setQueryData<InboxPages>(LIST_KEY, (d) =>
        d
          ? {
              ...d,
              pages: d.pages.map((p) => ({ ...p, items: p.items.filter((n) => n._id !== id) })),
            }
          : d,
      );
      return { before };
    },
    onError: (_e, _id, ctx) => {
      // 다시 읽기마저 실패해도 지우지 못한 알림이 목록에 남게 되돌린다
      if (ctx?.before) qc.setQueryData(LIST_KEY, ctx.before);
      toast('알림을 지우지 못했어요. 다시 시도해 주세요');
    },
    // 여러 개를 잇달아 지우면 마지막 삭제가 끝난 뒤에만 다시 읽는다(먼저 끝난 응답이 아직 지우는 중인 알림을 되살리지 않게)
    onSettled: () => {
      if (qc.isMutating({ mutationKey: REMOVE_KEY }) === 1) refresh();
    },
  });
  const unread = useUnreadCount();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // 아직 안 불러온 쪽에 안 읽은 알림이 있을 수 있어 서버 수도 본다
  const hasUnread = (unread.data ?? 0) > 0 || items.some((n) => !n.readAt);
  return (
    <Canvas>
      <Screen refresh={{ refreshing: list.isRefetching, onRefresh: refresh }}>
        <Header
          title="알림"
          right={
            items.length > 0 && (
              <Pressable
                accessibilityRole="button"
                disabled={!hasUnread || readAll.isPending}
                onPress={() => readAll.mutate()}
                hitSlop={8}
              >
                <Text
                  className={cx(
                    'text-footnote font-semibold',
                    hasUnread ? 'text-brand' : 'text-sub',
                  )}
                >
                  모두 읽음
                </Text>
              </Pressable>
            )
          }
        />
        {list.isError && !list.data && (
          <LoadError message="알림을 불러오지 못했어요" retry={list.refetch} />
        )}
        {list.isPending && <Loading />}
        {list.isSuccess && items.length === 0 && (
          <Empty icon={<Bell size={32} color={C.brand} />} title="아직 받은 알림이 없어요" />
        )}
        {items.length > 0 && (
          <Group>
            {items.map((n) => (
              <SwipeAction
                key={n._id}
                label="삭제"
                name={n.title}
                onAction={() => remove.mutate(n._id)}
              >
                {/* 흰 바탕: 밀기 전에는 뒤의 빨간 삭제 칸이 비치지 않게 */}
                <View className="bg-white">
                  <Row
                    onPress={() => openNotification(n, qc)}
                    onLongPress={() => setRemoving(n)}
                    sub={`${n.body} · ${timeAgo(n.createdAt)}`}
                    right={
                      !n.readAt ? (
                        <View
                          accessible
                          accessibilityLabel="안 읽음"
                          className="h-2 w-2 rounded-full bg-brand"
                        />
                      ) : undefined
                    }
                  >
                    <Text
                      className={cx(
                        'text-callout',
                        n.readAt ? 'text-sub' : 'font-semibold text-ink',
                      )}
                    >
                      {n.title}
                    </Text>
                  </Row>
                </View>
              </SwipeAction>
            ))}
          </Group>
        )}
        {list.hasNextPage && (
          <Pressable
            accessibilityRole="button"
            onPress={() => void list.fetchNextPage()}
            className="items-center py-4"
          >
            <Text className="text-footnote text-sub">
              {list.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
            </Text>
          </Pressable>
        )}
      </Screen>
      <Alert
        open={!!removing}
        title="알림을 삭제할까요?"
        body={removing?.title ?? ''}
        secondary="취소"
        onSecondary={() => setRemoving(null)}
        primary="삭제"
        onPrimary={() => {
          if (removing) remove.mutate(removing._id);
          setRemoving(null);
        }}
      />
    </Canvas>
  );
}

/** 사용자 설정 저장(낙관적 갱신). 설정 화면 · 채팅 음소거가 같이 쓴다 */
function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    // 차례로 보낸다: 음소거 목록처럼 배열 전체를 보내는 저장이 순서가 뒤바뀌어 덮이지 않게
    scope: { id: 'settings' },
    mutationFn: (s: Partial<UserSettings>) => api.me.update({ settings: s }),
    onMutate: async (s) => {
      // 진행 중인 다시 읽기가 방금 바꾼 값을 되돌리지 않게
      await qc.cancelQueries({ queryKey: ['me'] });
      const before = qc.getQueryData(['me']);
      qc.setQueryData(['me'], (u: { settings: UserSettings } | undefined) =>
        u ? { ...u, settings: { ...u.settings, ...s } } : u,
      );
      return { before };
    },
    onError: (_e, _s, ctx) => {
      // 오프라인이면 다시 읽기도 실패하므로 저장 전 값으로 직접 되돌린다
      if (ctx) qc.setQueryData(['me'], ctx.before);
      toast('설정을 저장하지 못했어요. 다시 시도해 주세요');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

/** 이 채팅방(1:1 · 스터디룸) 알림 음소거. 서버가 settings.mutedChatRoomIds에 있는 방의 새 메시지 푸시를 보내지 않는다 */
export function useChatMute(chatRoomId: string | undefined) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get() });
  const save = useSaveSettings();
  const muted = me.data?.settings?.mutedChatRoomIds ?? [];
  const on = !!chatRoomId && muted.includes(chatRoomId);
  return {
    ready: !!chatRoomId && !!me.data,
    muted: on,
    toggle: () => {
      if (!chatRoomId || !me.data) return;
      save.mutate({
        mutedChatRoomIds: on ? muted.filter((x) => x !== chatRoomId) : [...muted, chatRoomId],
      });
    },
  };
}

const KINDS: { key: keyof UserSettings; label: string; sub: string }[] = [
  { key: 'notifyFriend', label: '친구', sub: '친구 요청 · 수락, 시간표 공유' },
  { key: 'notifyChat', label: '채팅', sub: '1:1 · 스터디룸 새 메시지' },
  { key: 'notifyRoom', label: '스터디룸', sub: '초대 · 공유 자료 · 타이머' },
  { key: 'notifyStudy', label: '공부', sub: 'D-day · 오늘의 복습 · 반복 목표' },
  { key: 'notifyAi', label: 'AI 작업', sub: '노트 정리 · 퀴즈 만들기 완료' },
];
const DEFAULT_QUIET = { start: '23:00', end: '07:00' };
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

export function NotificationSettingsScreen() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get() });
  const save = useSaveSettings();
  const [pick, setPick] = useState<null | 'start' | 'end'>(null);
  if (me.isError && !me.data)
    return (
      <Canvas>
        <Screen>
          <Header title="알림 설정" />
          <LoadError message="설정을 불러오지 못했어요" retry={me.refetch} />
        </Screen>
      </Canvas>
    );
  if (!me.data)
    return (
      <Canvas>
        <Screen>
          <Header title="알림 설정" />
          <Loading />
        </Screen>
      </Canvas>
    );
  const s = me.data.settings;
  const quiet = s.quietHours ?? null;
  return (
    <Canvas>
      <Screen>
        <Header title="알림 설정" />
        <Label>받을 알림</Label>
        <Group>
          {KINDS.map((k) => (
            <Row
              key={k.key}
              sub={k.sub}
              right={
                <Toggle
                  label={`${k.label} 알림`}
                  on={s[k.key] !== false}
                  onChange={(v) => save.mutate({ [k.key]: v })}
                />
              }
            >
              {k.label}
            </Row>
          ))}
        </Group>
        <Text className="mt-2 px-1 text-caption text-sub">
          스터디룸에서 내보내졌을 때는 설정과 상관없이 알려 드려요
        </Text>
        <Label>조용한 시간</Label>
        <Group>
          <Row
            sub="이 시간에는 소리 · 배너 없이 알림함에만 남겨요"
            right={
              <Toggle
                label="조용한 시간"
                on={!!quiet}
                onChange={(v) => save.mutate({ quietHours: v ? DEFAULT_QUIET : null })}
              />
            }
          >
            조용한 시간
          </Row>
          {quiet && (
            <>
              <Row
                onPress={() => setPick('start')}
                right={<Text className="text-footnote text-sub">{quiet.start}</Text>}
              >
                시작
              </Row>
              <Row
                onPress={() => setPick('end')}
                right={<Text className="text-footnote text-sub">{quiet.end}</Text>}
              >
                끝
              </Row>
            </>
          )}
        </Group>
        <Sheet
          open={!!pick && !!quiet}
          onClose={() => setPick(null)}
          title={pick === 'start' ? '시작 시각' : '끝 시각'}
        >
          <View className="flex-row flex-wrap gap-2 pb-2">
            {HOURS.map((h) => {
              const now = pick && quiet ? quiet[pick] : null;
              // 시작 = 끝이면 서버가 조용한 시간을 끈 것으로 본다 → 고르지 못하게
              const other = pick && quiet ? quiet[pick === 'start' ? 'end' : 'start'] : null;
              return (
                <Pressable
                  key={h}
                  accessibilityRole="button"
                  accessibilityState={{ selected: h === now, disabled: h === other }}
                  disabled={h === other}
                  onPress={() => {
                    if (!pick || !quiet) return;
                    save.mutate({ quietHours: { ...quiet, [pick]: h } });
                    setPick(null);
                  }}
                  className={cx(
                    'h-control w-[22%] items-center justify-center rounded-card',
                    h === now ? 'bg-brand' : 'bg-fill',
                    h === other && 'opacity-40',
                  )}
                >
                  <Text className={cx('text-footnote', h === now ? 'text-white' : 'text-ink')}>
                    {h}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Sheet>
      </Screen>
    </Canvas>
  );
}

/** 홈 상단 종 아이콘(읽지 않은 수 점) */
export function BellButton() {
  const unread = useUnreadCount();
  // 홈이 보일 때마다 다시 읽는다: 30초 캐시라 그 사이 온 알림 수가 늦게 바뀌었다(PROF-007).
  // 이미 읽는 중이면(처음 그릴 때 useQuery가 읽기 시작) 겹쳐 보내지 않는다
  const qc = useQueryClient();
  useFocusEffect(
    useCallback(() => {
      if (qc.getQueryState(UNREAD_KEY)?.fetchStatus !== 'fetching')
        void qc.refetchQueries({ queryKey: UNREAD_KEY, exact: true });
    }, [qc]),
  );
  const n = unread.data ?? 0;
  return (
    <Pressable
      accessibilityLabel={n ? `알림 ${n}개 안 읽음` : '알림'}
      onPress={() => router.push('/notifications')}
      className="h-11 w-11 items-center justify-center rounded-full bg-white"
    >
      <Bell size={ICON.md} color={C.brand} />
      {n > 0 && (
        <View className="absolute -right-0.5 -top-0.5 h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1">
          <Text className="text-caption2 text-white">{n > 99 ? '99+' : n}</Text>
        </View>
      )}
    </Pressable>
  );
}
