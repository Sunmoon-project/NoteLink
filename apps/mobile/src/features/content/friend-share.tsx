import { useRef } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MaterialKind } from '@notelink/shared';

import { Text } from '@/components/text';
import { Btn } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { toast } from '@/stores/toast';

// 친구에게 받은 · 보낸 노트(#554). 1:1 채팅 공유 카드 → 노트 상세(?share=공유 id) → 읽기 전용 · 내 노트로 복사 · 공유 끝내기

const ENDED = '공유가 끝났어요';
/** 받은 사람이 노트를 열어 둔 동안 철회 · 친구 끊김을 알아채는 주기(알림 수 UNREAD_REFETCH_MS 처럼 다시 읽기) */
const FRIEND_SHARE_REFETCH_MS = 30_000;
const gone = (e: unknown) => e instanceof ApiError && e.status === 404;

export const notePath = (kind: MaterialKind | null) =>
  kind === 'handwriting'
    ? '/(tabs)/note/hand/[id]'
    : kind === 'recording'
      ? '/(tabs)/note/rec/[id]'
      : '/(tabs)/note/doc/[id]';

/**
 * 1:1 채팅 공유 카드를 눌렀을 때. 받은 사람에게 끝난 공유(철회 · 친구 끊김 · 노트 지움 · 보낸 사람 탈퇴)는 「공유가 끝났어요」.
 * 친구를 끊었다 다시 맺은 뒤의 옛 카드는 서버가 404 라 같은 안내다
 */
export function useOpenFriendShare() {
  const openFeature = useFeatureNavigation();
  const qc = useQueryClient();
  const opening = useRef(false);
  return async (shareId: string) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const share = await qc.fetchQuery({
        queryKey: ['friend-share', shareId],
        queryFn: () => api.content.friendShare(shareId),
        // 앱 기본 30초 캐시를 쓰면 방금 끝난 공유도 열린다. 카드를 누를 때마다 서버에 묻는다
        staleTime: 0,
      });
      if (!share.active && !share.mine) return toast(ENDED);
      openFeature({
        pathname: notePath(share.kind),
        params: { id: share.materialId, share: share._id },
      });
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? ENDED : '이 자료를 열 수 없어요');
    } finally {
      opening.current = false;
    }
  };
}

/** 노트 상세가 공유 카드에서 열렸는지. 받은 사람이면 readOnly(편집 · 삭제 · 공유 · 묻기를 숨긴다) */
export function useFriendShare() {
  const { share } = useLocalSearchParams<{ share?: string }>();
  const q = useQuery({
    queryKey: ['friend-share', share],
    queryFn: () => api.content.friendShare(share!),
    enabled: !!share,
    staleTime: 0,
    // 살아 있는 받은 공유만 다시 묻는다. 끝났거나(404 포함) 내가 보낸 공유면 멈춘다
    refetchInterval: (q) =>
      q.state.data?.active && !q.state.data.mine && !gone(q.state.error)
        ? FRIEND_SHARE_REFETCH_MS
        : false,
  });
  // 불러오는 동안에도 받은 사람으로 본다(주인 버튼이 잠깐 보였다 사라지지 않게)
  return {
    shareId: share,
    data: q.data,
    error: q.error,
    readOnly: !!share && !q.data?.mine,
  };
}

/** 공유 카드에서 연 노트의 아래 버튼: 받은 사람은 「내 노트로 복사」, 보낸 사람은 「공유 끝내기」. 끝난 공유는 안내만 */
export function FriendShareFooter({ shareId }: { shareId: string }) {
  const qc = useQueryClient();
  const { data, error } = useFriendShare();
  const fail = (e: unknown) =>
    toast(
      e instanceof ApiError && e.status >= 400 && e.status < 500 && e.message
        ? e.message
        : '연결을 확인하고 다시 시도해 주세요',
    );
  const copy = useMutation({
    mutationFn: () => api.content.copyFriendShare(shareId),
    onError: fail,
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: ['materials', made.folderId] });
      void qc.invalidateQueries({ queryKey: ['folders'] });
      toast('내 노트로 복사했어요');
      router.replace({ pathname: notePath(data?.kind ?? null), params: { id: made._id } });
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.content.revokeFriendShare(shareId),
    onError: fail,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['friend-share', shareId] });
      toast('공유를 끝냈어요');
    },
  });
  // 열어 둔 사이 친구를 끊으면 공유가 지워져 404 다. 다시 묻다 404 가 나면 예전 data 가 남아 있어도 끝난 공유다
  if (gone(error)) return <Text className="py-3 text-center text-footnote text-sub">{ENDED}</Text>;
  if (!data)
    return error ? (
      <Text className="py-3 text-center text-footnote text-sub">공유 정보를 불러오지 못했어요</Text>
    ) : null;
  if (!data.active) return <Text className="py-3 text-center text-footnote text-sub">{ENDED}</Text>;
  return (
    <View className="gap-2">
      <Text className="text-center text-caption text-sub">
        {data.mine ? '친구에게 보낸 노트예요' : `${data.ownerNickname}님이 보낸 노트 · 읽기 전용`}
      </Text>
      {data.mine ? (
        <Btn kind="outline" loading={revoke.isPending} onPress={() => revoke.mutate()}>
          공유 끝내기
        </Btn>
      ) : (
        <Btn loading={copy.isPending} onPress={() => copy.mutate()}>
          내 노트로 복사
        </Btn>
      )}
    </View>
  );
}
