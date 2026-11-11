import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShopItem } from '@notelink/shared';
import { Check, ShoppingBag } from 'lucide-react-native';
import { Text } from '@/components/text';
import { Btn, Canvas, Header, Label, Loading, Screen, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { BASE_AVATAR } from '@/lib/local/catalog';
import { ItemPreview } from '@/features/reward/shop';
import { toast } from '@/stores/toast';
import { LoadError } from '../progress/load-error';
import { C, ICON } from '@/theme';
import { Avatar3D, type Mood } from './avatar3d';
import { LOCAL_AVATARS, readKnown, useEquippedAvatar, useEquippedItem, useFocused } from './buddy';

/**
 * 아바타 선생님 고르기(프로필 > 계정 정보). 기본 · 보유한 상점 아바타 중 하나를 장착하면 노트를
 * 설명하는 3D 선생님 얼굴이 바뀐다. 프로필 사진과는 따로다. 없는 아바타는 상점에서 산다.
 */
export function AvatarTeacherScreen() {
  const qc = useQueryClient();
  const equipped = useEquippedItem();
  // 미리보기도 다른 화면의 선생님과 같은 얼굴(판매가 끝난 상품은 기기에 적어 둔 모델)
  const face = useEquippedAvatar();
  // 상점처럼 다른 화면이 위에 쌓이면 보이지 않는 3D를 그리지 않는다(TutorStage와 같게)
  const focused = useFocused();
  const mine = useQuery({ queryKey: ['my-items'], queryFn: () => api.shop.myItems() });
  const all = useQuery({ queryKey: ['shop', 'all'], queryFn: () => api.shop.items({}) });
  const owned = new Set((mine.data ?? []).filter((u) => u.isOwned).map((u) => u.itemId));
  const listed = new Set((all.data ?? []).map((i) => i._id));
  // 판매가 끝난 보유 아바타는 판매 목록에 없다: 전에 본 모델(기기에 적어 둠)의 그림으로 보여 주고 장착도 된다
  const known = useQuery({ queryKey: ['avatar-models'], queryFn: readKnown });
  const retired = (mine.data ?? [])
    .filter((u) => u.isOwned && u.itemCategory === 'avatar' && !listed.has(u.itemId))
    .filter((u) => !LOCAL_AVATARS.some((a) => a._id === u.itemId))
    .map((u): ShopItem => {
      const seen = LOCAL_AVATARS.find((a) => a._id === known.data?.[u.itemId]);
      return seen
        ? { ...seen, _id: u.itemId }
        : { ...BASE_AVATAR, _id: u.itemId, name: '판매가 끝난 아바타' };
    });
  const avatars = [
    BASE_AVATAR,
    ...(all.data ?? []).filter((i) => i.category === 'avatar' && owned.has(i._id)),
    ...retired,
  ];
  const more = (all.data ?? []).filter((i) => i.category === 'avatar' && !owned.has(i._id));

  // 고르면 미리보기 선생님이 잠깐 인사한다
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSaid(equipped), 1600);
    return () => clearTimeout(t);
  }, [equipped]);
  const mood: Mood = said === equipped ? 'idle' : 'talking';

  const equip = useMutation({
    mutationFn: (it: ShopItem) => api.shop.equip(it._id),
    onSuccess: async (_, it) => {
      await qc.invalidateQueries({ queryKey: ['my-items'] });
      toast(`${it.name}가 아바타 선생님이 됐어요`);
    },
    onError: () => toast('장착하지 못했어요. 다시 시도해 주세요'),
  });

  // 못 읽었으면 "보유 아바타 없음 · 기본 장착 중"처럼 보이지 않게 안내하고 다시 읽는다
  if ((mine.isError && !mine.data) || (all.isError && !all.data))
    return (
      <Canvas>
        <Screen>
          <Header title="아바타 선생님" large={false} />
          <LoadError
            message="아바타 목록을 불러오지 못했어요"
            retry={() =>
              Promise.all([mine.isError && mine.refetch(), all.isError && all.refetch()])
            }
          />
        </Screen>
      </Canvas>
    );
  if (mine.isPending || all.isPending) return <Loading />;
  return (
    <Canvas>
      <Screen>
        <Header
          title="아바타 선생님"
          sub="고른 아바타가 노트를 설명해 주는 선생님이 돼요"
          large={false}
        />
        <View className="items-center rounded-card bg-mint py-3">
          {focused && <Avatar3D mood={mood} avatarId={face} size={180} />}
        </View>

        <Label>내 아바타</Label>
        <View className="flex-row flex-wrap gap-3">
          {avatars.map((it) => {
            const on = it._id === equipped;
            return (
              <Pressable
                key={it._id}
                accessibilityRole="button"
                accessibilityLabel={`${it.name}${on ? ', 장착 중' : ''}`}
                accessibilityState={{ selected: on, disabled: equip.isPending }}
                disabled={on || equip.isPending}
                onPress={() => equip.mutate(it)}
                className={cx(
                  'w-[30.5%] items-center gap-1 rounded-card border-2 bg-white py-3',
                  on ? 'border-brand' : 'border-transparent',
                )}
              >
                <ItemPreview item={it} small />
                <Text className="text-caption font-semibold text-ink" numberOfLines={1}>
                  {it.name.replace(/ 아바타$/, '')}
                </Text>
                {on && (
                  <View className="absolute top-2 right-2 h-5 w-5 items-center justify-center rounded-full bg-brand">
                    <Check size={12} color="#fff" strokeWidth={3} />
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>

        {more.length > 0 && (
          <View className="mt-6 flex-row items-center gap-3 rounded-card bg-white p-4">
            <View className="h-10 w-10 items-center justify-center rounded-full bg-mint">
              <ShoppingBag size={ICON.sm} color={C.brand} />
            </View>
            <View className="flex-1">
              <Text className="text-subhead font-semibold text-ink">
                다른 아바타 {more.length}개가 상점에 있어요
              </Text>
              <Text className="text-caption text-sub">포인트로 사면 여기에서 고를 수 있어요</Text>
            </View>
            <Btn small kind="outline" onPress={() => router.push('/shop')}>
              상점
            </Btn>
          </View>
        )}
      </Screen>
    </Canvas>
  );
}
