import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { SlideInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react-native';
import type { User } from '@notelink/shared';
import { api } from '@/lib/api';
import { Avatar, Btn, Sheet, cx } from '@/components/ui';
import { C, ICON } from '@/theme';
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
  const go = (href: Parameters<typeof router.push>[0]) => {
    onClose();
    router.push(href);
  };
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1">
        <Pressable
          accessibilityLabel="닫기"
          className="absolute inset-0 bg-black/45"
          onPress={onClose}
        />
        <Animated.View
          entering={SlideInRight.duration(240)}
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
            className="mt-2 flex-row items-center rounded-xl bg-cream px-3 py-3"
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
                className="flex-row items-center gap-3 rounded-2xl bg-cream px-3 py-3"
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
        <StatusSheet
          open={statusOpen}
          onClose={() => setStatusOpen(false)}
          current={me.data?.status ?? 'active'}
        />
      </View>
    </Modal>
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
              current === st ? 'bg-mint' : 'bg-cream',
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
