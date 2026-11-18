import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import Animated, { SlideInRight, SlideOutRight, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react-native';
import type { User } from '@notelink/shared';
import { api } from '@/lib/api';
import { Avatar, BACKDROP_IN, BACKDROP_OUT, Btn, Sheet, cx } from '@/components/ui';
import { C, EASE, EASE_SHEET, ICON, MOTION } from '@/theme';
import { toast } from '@/stores/toast';

// p.53 #18 소셜 드로어 / p.55 #24 내 상태 변경

export const STATUS: Record<User['status'], { label: string; dot: string }> = {
  active: { label: '활동 중', dot: 'bg-brand' },
  busy: { label: '활동 중', dot: 'bg-brand' },
  resting: { label: '쉬는 중', dot: 'bg-sun' },
  offline: { label: '오프라인', dot: 'bg-sub/60' },
};

export const StatusText = ({ status }: { status: User['status'] }) => (
  <View className="flex-row items-center">
    <View
      className={cx(
        'mr-1 h-1.5 w-1.5 rounded-full',
        (Object.hasOwn(STATUS, status) ? STATUS[status] : STATUS.offline).dot,
      )}
    />
    <Text className="text-caption2 text-sub">
      {(Object.hasOwn(STATUS, status) ? STATUS[status] : STATUS.offline).label}
    </Text>
  </View>
);

/**
 * 친구 창 화면(/friends) 옵션. 홈 위에 겹쳐 뜨려면 띄우기 전에 정해져야 해서 루트 스택(app/_layout)에서 선언한다.
 * 화면 안의 <Stack.Screen options>로만 주면 iOS가 이미 불투명한 일반 화면으로 띄워 홈이 회색으로 가려졌다
 */
export const DRAWER_SCREEN = {
  presentation: 'transparentModal',
  animation: 'none',
  contentStyle: { backgroundColor: 'transparent' },
} as const;

export function SocialDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get, enabled: open });
  const friends = useQuery({ queryKey: ['friends'], queryFn: api.social.friends, enabled: open });
  const requests = useQuery({
    queryKey: ['friend-requests'],
    queryFn: api.social.received,
    enabled: open,
  });
  const [statusOpen, setStatusOpen] = useState(false);
  // 하위 화면은 친구 창 위에 쌓는다: 뒤로 가면 친구 창이 다시 보인다(바꿔치기하면 곧장 홈으로 갔다).
  // 드로어를 닫지 않으니 사이에 홈 화면이 비치지도 않는다
  const go = (href: Parameters<typeof router.push>[0]) => router.push(href);
  // 닫을 때: 막 · 패널을 먼저 빼서 나가는 모션(exiting)을 보인 뒤 화면을 닫는다. 동작 줄이기면 바로 닫는다
  const reduced = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = () => {
    if (reduced) return onClose();
    if (closing) return;
    setClosing(true);
    timer.current = setTimeout(onClose, MOTION.exit);
  };
  if (!open) return null;
  return (
    // /friends가 이미 투명 화면이다. Modal을 쓰면 다음 화면으로 갈 때 Modal이 먼저 사라지며 빈 화면이 비친다
    <View className="flex-1">
      {!closing && (
        <Animated.View entering={BACKDROP_IN} exiting={BACKDROP_OUT} className="absolute inset-0">
          <Pressable accessibilityLabel="닫기" className="flex-1 bg-black/45" onPress={close} />
        </Animated.View>
      )}
      {!closing && (
        <Animated.View
          entering={SlideInRight.duration(MOTION.enter).easing(EASE)}
          exiting={SlideOutRight.duration(MOTION.exit).easing(EASE_SHEET)}
          className="absolute top-0 right-0 bottom-0 w-[80%] bg-white px-4"
          style={{ paddingTop: insets.top + 16 }}
        >
          <Pressable
            onPress={() => setStatusOpen(true)}
            className="flex-row items-center gap-3 rounded-2xl bg-mint/60 px-3 py-3"
          >
            <Avatar name={me.data?.nickname} uri={me.data?.avatarUrl} size={36} tone="mint" />
            <View className="flex-1">
              <Text className="text-subhead font-semibold text-ink">{me.data?.nickname}</Text>
              {me.data && (
                <View className="flex-row items-center">
                  <StatusText status={me.data.status} />
                  <Text className="text-caption2 text-sub"> · 눌러서 변경</Text>
                </View>
              )}
            </View>
            <ChevronRight size={ICON.sm} color={C.sub} />
          </Pressable>
          <Btn small className="mt-3" onPress={() => go('/friend-add')}>
            + 친구 추가
          </Btn>
          <Pressable
            onPress={() => go('/requests')}
            className="mt-2 flex-row items-center rounded-xl bg-fill px-4 py-3"
          >
            <Text className="flex-1 text-subhead text-ink">받은 친구 요청</Text>
            {!!requests.data?.length && (
              <View className="h-5 w-5 items-center justify-center rounded-full bg-danger">
                <Text className="text-caption2 text-white">{requests.data.length}</Text>
              </View>
            )}
            <ChevronRight size={ICON.sm} color={C.sub} />
          </Pressable>
          <Text className="mt-4 mb-2 text-caption text-sub">친구 {friends.data?.length ?? 0}</Text>
          {friends.isError && !friends.data && (
            <View className="gap-2 pb-3">
              <Text className="text-footnote text-sub">친구 목록을 불러오지 못했어요</Text>
              <Btn small onPress={() => void friends.refetch()}>
                친구 목록 다시 시도
              </Btn>
            </View>
          )}
          <ScrollView className="flex-1" contentContainerClassName="gap-2 pb-6">
            {friends.data?.map((f) => (
              <Pressable
                key={f._id}
                onPress={() =>
                  go({
                    pathname: '/chat/[id]',
                    params: { id: f.userId, name: f.nickname, status: f.status },
                  })
                }
                className="flex-row items-center gap-3 rounded-2xl bg-fill px-4 py-3"
              >
                <Avatar name={f.nickname} size={32} tone="mint" />
                <View className="flex-1">
                  <Text className="text-subhead font-semibold text-ink">{f.nickname}</Text>
                  <StatusText status={f.status} />
                </View>
                <MoreHorizontal size={ICON.sm} color={C.sub} />
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      )}
      <StatusSheet
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        current={me.data?.status ?? 'active'}
      />
    </View>
  );
}

function StatusSheet({
  open,
  onClose,
  current,
}: {
  open: boolean;
  onClose: () => void;
  current: User['status'];
}) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (s: User['status']) => api.me.setStatus(s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      onClose();
    },
    onError: () => toast('상태 변경에 실패했어요. 다시 시도해주세요'),
  });
  return (
    <Sheet open={open} onClose={onClose} title="상태 변경">
      <View className="gap-2">
        {(['active', 'resting', 'offline'] as const).map((st) => (
          <Pressable
            key={st}
            onPress={() => set.mutate(st)}
            className={cx(
              'flex-row items-center rounded-xl px-4 py-3.5',
              current === st ? 'bg-mint' : 'bg-fill',
            )}
          >
            <View className={cx('mr-2 h-2 w-2 rounded-full', STATUS[st].dot)} />
            <Text className="flex-1 text-subhead text-ink">{STATUS[st].label}</Text>
            {current === st && <Check size={ICON.sm} color={C.brand} />}
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}
