import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Frown,
  Heart,
  Package,
  ShoppingBasket,
  X,
} from 'lucide-react-native';
import { ERROR_CODES, type ShopItem } from '@notelink/shared';
import { api, ApiError, NetworkError } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { clock } from '@/lib/dates';
import { BASE_AVATAR } from '@/lib/shop-items';
import { Alert, Badge, Btn, Canvas, Dialog, Loading, Sheet, Two, cx } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.91~95 상점 · 정렬 · 상세 · 구매 · 포인트 내역 · 보관함 / p.101 구매 중 연결 끊김

type Sort = 'latest' | 'price' | 'popular';
const SORT_LABEL: Record<Sort, string> = {
  latest: '최신순',
  price: '낮은 가격순',
  popular: '인기순',
};

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 2600);
    return () => clearTimeout(t);
  }, [msg]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Animated.View
      entering={FadeInUp}
      className="mt-2 flex-row items-center rounded-xl bg-ink px-4 py-2.5"
    >
      <Text className="flex-1 text-footnote font-semibold text-white">{msg}</Text>
      <Pressable accessibilityLabel="닫기" onPress={onClose} hitSlop={10}>
        <X size={ICON.sm} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

function ItemPreview({ item, large = false }: { item: ShopItem; large?: boolean }) {
  const size = large ? 96 : 64;
  const label = `${item.name} 미리보기`;
  if (item.thumbnailUrl && /^(https?:|file:|data:)/.test(item.thumbnailUrl))
    return (
      <Image
        accessibilityRole="image"
        accessibilityLabel={label}
        source={{ uri: item.thumbnailUrl }}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
    );
  return (
    <View accessibilityLabel={label}>
      {item.thumbnailUrl ? (
        <Text className={large ? 'text-display-lg' : 'text-display'}>{item.thumbnailUrl}</Text>
      ) : (
        <Package size={size} color={C.brand} />
      )}
    </View>
  );
}

function ShopError({ retry }: { retry: () => unknown }) {
  return (
    <View className="flex-1 items-center justify-center p-5">
      <Text>상점 정보를 불러오지 못했어요</Text>
      <Btn
        onPress={() => {
          void retry();
        }}
      >
        다시 시도
      </Btn>
    </View>
  );
}

function useShopData() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const mine = useQuery({ queryKey: ['my-items'], queryFn: api.shop.myItems });
  const owned = new Set((mine.data ?? []).filter((u) => u.isOwned).map((u) => u.itemId));
  const wished = new Set((mine.data ?? []).filter((u) => u.isWished).map((u) => u.itemId));
  const equippedIds = new Set((mine.data ?? []).filter((u) => u.isEquipped).map((u) => u.itemId));
  const equipped =
    mine.data?.find((u) => u.isEquipped && u.itemCategory === 'avatar')?.itemId ?? 'base';
  return {
    points: me.data?.pointBalance ?? 0,
    owned,
    wished,
    equipped,
    equippedIds,
    loaded: mine.isSuccess,
    pending: me.isPending || mine.isPending,
    // 이미 불러온 내용이 있으면 재조회 실패로 화면을 지우지 않는다
    error: (me.isError && !me.data) || (mine.isError && !mine.data),
    retry: () => Promise.all([me.refetch(), mine.refetch()]),
  };
}

export function ShopScreen() {
  const openFeature = useFeatureNavigation();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'전체' | '아바타' | '테마' | '찜'>('전체');
  const [sort, setSort] = useState<Sort>('latest');
  const items = useQuery({
    queryKey: ['shop', tab, sort],
    queryFn: () =>
      api.shop.items({
        category: tab === '아바타' ? 'avatar' : tab === '테마' ? 'theme' : undefined,
        sort,
      }),
  });
  const shop = useShopData();
  const { points, owned, wished } = shop;
  const [sortOpen, setSortOpen] = useState(false);
  const [detail, setDetail] = useState<ShopItem | null>(null);
  const [confirm, setConfirm] = useState<ShopItem | null>(null);
  const [poor, setPoor] = useState<ShopItem | null>(null);
  const [fail, setFail] = useState(false);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [msg, setMsg] = useState<string | null>(null);
  const buying = useRef(false);
  const purchased = useRef(new Set<string>());

  const wish = useMutation({
    mutationFn: api.shop.wish,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-items'] }),
  });
  const buy = useMutation({
    mutationFn: (it: ShopItem) => api.shop.purchase(it._id),
    retry: false,
    onSuccess: (_, it) => {
      purchased.current.add(it._id);
      setConfirm(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['my-items'] });
      // 포인트 내역을 열어 둔 적이 있어도 새 구매 내역이 바로 보이게
      qc.invalidateQueries({ queryKey: ['ledger'] });
      setMsg(`🎉 구매 완료 · ${it.name}`);
    },
    onSettled: () => {
      buying.current = false;
    },
    onError: (e, it) => {
      if (e instanceof ApiError && e.code === ERROR_CODES.POINTS_INSUFFICIENT) setPoor(it);
      else if (e instanceof NetworkError) {
        setUncertainId(it._id);
        setFail(true);
      } else setMsg('구매하지 못했어요');
    },
  });
  const checkPurchase = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const [me, mine, ledger] = await Promise.all([
        api.me.get(),
        api.shop.myItems(),
        api.shop.ledger(),
      ]);
      qc.setQueryData(['me'], me);
      qc.setQueryData(['my-items'], mine);
      qc.setQueryData(['ledger', '전체'], ledger);
      qc.invalidateQueries({ queryKey: ['ledger'] });
      const confirmed = mine.some((u) => u.itemId === uncertainId && u.isOwned);
      setUncertainId(null);
      setFail(false);
      setMsg(
        confirmed
          ? '구매 완료를 확인했어요'
          : '현재 보유 내역에 없어요. 구매하려면 상품을 다시 선택해 주세요',
      );
    } catch {
      setMsg('구매 결과를 확인하지 못했어요. 연결 후 다시 확인해주세요');
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };
  // 찜 탭도 고른 정렬을 따른다 — '찜'은 카테고리가 없으므로 items가 정렬된 전체 목록이다
  const list =
    tab === '찜' ? (items.data ?? []).filter((i) => wished.has(i._id)) : (items.data ?? []);
  const tryBuy = (it: ShopItem) => {
    if (buying.current || owned.has(it._id) || purchased.current.has(it._id)) return;
    // 잔액과 보유 내역을 읽기 전에는 포인트가 0인 것처럼 판단하지 않는다
    if (shop.pending) return setMsg('보유 포인트를 확인하고 있어요. 잠시 후 다시 눌러 주세요');
    setDetail(null);
    if (uncertainId) {
      setFail(true);
      return;
    }
    if (it.price > points) setPoor(it);
    else setConfirm(it);
  };

  if (shop.error || (items.isError && !items.data))
    return <ShopError retry={() => Promise.all([shop.retry(), items.refetch()])} />;
  return (
    <Canvas>
      <View className="flex-1" style={{ paddingTop: insets.top }}>
        <ScrollView className="flex-1" contentContainerClassName="px-5 pb-8">
          {msg ? (
            <Toast msg={msg} onClose={() => setMsg(null)} />
          ) : (
            <View className="h-12 flex-row items-center justify-between pt-2">
              <Pressable onPress={() => router.back()} className="flex-row items-center">
                <ChevronLeft size={ICON.md} color={C.ink} />
                <Text className="text-callout font-bold text-ink">상점</Text>
              </Pressable>
              <Pressable onPress={() => router.push('/shop/box')} className="flex-row items-center">
                <Text className="text-subhead font-semibold text-ink">보관함</Text>
                <ChevronRight size={ICON.sm} color={C.ink} />
              </Pressable>
            </View>
          )}
          <Pressable
            onPress={() => router.push('/shop/points')}
            className="mt-2 rounded-2xl bg-mint px-4 py-3"
          >
            <Text className="text-caption2 text-sub">보유 포인트</Text>
            <Text className="text-headline font-bold text-ink">
              {shop.pending ? '확인 중…' : `${points.toLocaleString()} P`}
            </Text>
          </Pressable>
          {(shop.pending || items.isPending) && <Loading />}
          <View className="mt-4 flex-row gap-1">
            {(['전체', '아바타', '테마', '찜'] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                className={cx('rounded-lg px-3 py-1.5', tab === t && 'bg-mint')}
              >
                <Text
                  className={cx(
                    'text-footnote',
                    tab === t ? 'font-semibold text-brand' : 'text-sub',
                  )}
                >
                  {t}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => setSortOpen(true)}
            className="mt-1 flex-row items-center gap-1 self-end"
          >
            <Text className="text-caption text-sub">{SORT_LABEL[sort]}</Text>
            <ArrowUpDown size={ICON.xs} color={C.sub} />
          </Pressable>
          {list.length === 0 && (items.isSuccess || tab === '찜') ? (
            <View className="mt-3 items-center rounded-card bg-cream py-12">
              <ShoppingBasket size={ICON.xl} color={C.brand} />
              <Text className="mt-2 text-subhead font-semibold text-ink">
                {tab === '찜' ? '찜한 아이템이 없어요' : '준비 중인 아이템이에요'}
              </Text>
              <Text className="text-caption text-sub">
                {tab === '찜'
                  ? '♡를 눌러 마음에 드는 아이템을 모아보세요'
                  : '곧 새로운 아이템이 추가될 예정이에요'}
              </Text>
            </View>
          ) : (
            <View className="mt-2 flex-row flex-wrap justify-between gap-y-2.5">
              {list.map((it) => (
                <View key={it._id} className="w-[48.5%] rounded-card bg-white p-2">
                  <Pressable onPress={() => setDetail(it)}>
                    <View className="h-24 items-center justify-center rounded-xl bg-fill">
                      <ItemPreview item={it} />
                      {it.badge && (
                        <View
                          className={cx(
                            'absolute top-1.5 left-1.5 rounded-md px-1.5',
                            it.badge === 'NEW' ? 'bg-sun' : 'bg-orange',
                          )}
                        >
                          <Text className="text-caption2 font-bold text-white">{it.badge}</Text>
                        </View>
                      )}
                    </View>
                    <Text className="mt-2 px-1 text-footnote font-semibold text-ink">
                      {it.name}
                    </Text>
                    <Text className="px-1 text-caption2 text-sub">
                      {owned.has(it._id) ? '보유중' : `${it.price.toLocaleString()} P`}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={wished.has(it._id) ? '찜 해제' : '찜'}
                    onPress={() => wish.mutate(it._id)}
                    hitSlop={8}
                    className="absolute top-3.5 right-3.5"
                  >
                    <Heart
                      size={ICON.sm}
                      color={wished.has(it._id) ? C.danger : C.sub}
                      fill={wished.has(it._id) ? C.danger : 'transparent'}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        <Sheet open={sortOpen} onClose={() => setSortOpen(false)} title="정렬">
          <View className="gap-1.5">
            {(Object.keys(SORT_LABEL) as Sort[]).map((o) => (
              <Pressable
                key={o}
                onPress={() => {
                  setSort(o);
                  setSortOpen(false);
                }}
                className={cx(
                  'h-11 flex-row items-center rounded-xl px-4',
                  sort === o ? 'bg-mint' : 'bg-fill',
                )}
              >
                <Text className="flex-1 text-subhead text-ink">{SORT_LABEL[o]}</Text>
                {sort === o && <Check size={ICON.sm} color={C.brand} />}
              </Pressable>
            ))}
          </View>
        </Sheet>
        <Sheet open={!!detail} onClose={() => setDetail(null)}>
          {detail && (
            <>
              <View className="h-36 items-center justify-center rounded-2xl bg-fill">
                <ItemPreview item={detail} large />
              </View>
              <View className="mt-3 flex-row items-center justify-between">
                <Text className="text-body font-bold text-ink">{detail.name}</Text>
                {owned.has(detail._id) ? (
                  <Badge>보유중</Badge>
                ) : (
                  <Pressable
                    accessibilityLabel="찜"
                    onPress={() => wish.mutate(detail._id)}
                    className="h-8 w-8 items-center justify-center rounded-full bg-fill"
                  >
                    <Heart
                      size={ICON.sm}
                      color={wished.has(detail._id) ? C.danger : C.sub}
                      fill={wished.has(detail._id) ? C.danger : 'transparent'}
                    />
                  </Pressable>
                )}
              </View>
              {!owned.has(detail._id) && (
                <Text className="text-footnote text-sub">{detail.price.toLocaleString()} P</Text>
              )}
              <Text className="mt-1 text-caption text-sub">{detail.description}</Text>
              {owned.has(detail._id) ? (
                <Btn
                  className="mt-4"
                  onPress={() => {
                    setDetail(null);
                    router.push({ pathname: '/shop/box', params: { equip: detail._id } });
                  }}
                >
                  장착하러 가기
                </Btn>
              ) : (
                <Btn className="mt-4" onPress={() => tryBuy(detail)}>
                  구매
                </Btn>
              )}
            </>
          )}
        </Sheet>
        <Dialog open={!!confirm} onClose={() => setConfirm(null)}>
          {confirm && (
            <>
              <Text className="text-callout font-bold text-ink">{confirm.name}를 구매할까요?</Text>
              <View className="mt-4 w-full gap-1.5 rounded-xl bg-fill p-3">
                <View className="flex-row justify-between">
                  <Text className="text-footnote text-sub">차감 포인트</Text>
                  <Text className="text-footnote font-bold text-ink">{confirm.price} P</Text>
                </View>
                <View className="flex-row justify-between">
                  <Text className="text-footnote text-sub">구매 후 잔액</Text>
                  <Text className="text-footnote font-bold text-ink">
                    {points - confirm.price} P
                  </Text>
                </View>
              </View>
              <View className="mt-4 w-full">
                <Two>
                  <Btn small kind="outline" onPress={() => setConfirm(null)}>
                    취소
                  </Btn>
                  <Btn
                    small
                    loading={buy.isPending}
                    onPress={() => {
                      const it = confirm;
                      setConfirm(null);
                      const mine = qc.getQueryData<Awaited<ReturnType<typeof api.shop.myItems>>>([
                        'my-items',
                      ]);
                      if (
                        buying.current ||
                        purchased.current.has(it._id) ||
                        mine?.some((u) => u.itemId === it._id && u.isOwned)
                      )
                        return;
                      buying.current = true;
                      buy.mutate(it);
                    }}
                  >
                    구매
                  </Btn>
                </Two>
              </View>
            </>
          )}
        </Dialog>
        <Dialog open={!!poor} onClose={() => setPoor(null)}>
          {poor && (
            <>
              <Frown size={ICON.xl} color={C.brand} />
              <Text className="text-callout font-bold text-ink">포인트가 부족해요</Text>
              <Text className="mt-1 text-caption text-sub">
                {poor.name} 구매까지 {poor.price - points} P 더 필요해요
              </Text>
              <Btn
                small
                className="mt-4 w-full"
                onPress={() => {
                  if (openFeature('/(tabs)/quiz', 'navigate', '/play/solve')) setPoor(null);
                }}
              >
                포인트 모으러 가기
              </Btn>
              <Btn small kind="outline" className="mt-2 w-full" onPress={() => setPoor(null)}>
                닫기
              </Btn>
            </>
          )}
        </Dialog>
        <Alert
          open={fail}
          title="구매 결과를 확인해주세요"
          body="응답을 받지 못해 구매 여부를 확인할 수 없어요. 다시 구매하기 전에 잔액과 보유 아이템, 내역을 확인해주세요."
          secondary="닫기"
          onSecondary={() => setFail(false)}
          primary={checking ? '확인 중…' : '구매 결과 확인'}
          onPrimary={checkPurchase}
        />
      </View>
    </Canvas>
  );
}

export function PointsScreen() {
  const insets = useSafeAreaInsets();
  const shop = useShopData();
  const { points } = shop;
  const [tab, setTab] = useState<'전체' | '적립' | '사용'>('전체');
  const ledger = useQuery({
    queryKey: ['ledger', tab],
    queryFn: () => api.shop.ledger(tab === '전체' ? undefined : tab === '적립' ? 'earn' : 'spend'),
  });
  if (shop.error || (ledger.isError && !ledger.data))
    return <ShopError retry={() => Promise.all([shop.retry(), ledger.refetch()])} />;
  return (
    <ScrollView
      className="flex-1 bg-white"
      contentContainerClassName="px-5 pb-8"
      style={{ paddingTop: insets.top }}
    >
      <Pressable onPress={() => router.back()} className="h-12 flex-row items-center pt-2">
        <ChevronLeft size={ICON.md} color={C.ink} />
        <Text className="text-callout font-bold text-ink">포인트 내역</Text>
      </Pressable>
      <View className="mt-2 flex-row items-center justify-between rounded-2xl bg-mint px-4 py-3">
        <Text className="text-caption text-sub">보유 포인트</Text>
        <Text className="font-bold text-ink">{points.toLocaleString()} P</Text>
      </View>
      <View className="mt-3 flex-row gap-1">
        {(['전체', '적립', '사용'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            className={cx('rounded-lg px-3 py-1.5', tab === t && 'bg-mint')}
          >
            <Text
              className={cx('text-footnote', tab === t ? 'font-semibold text-brand' : 'text-sub')}
            >
              {t}
            </Text>
          </Pressable>
        ))}
      </View>
      <View className="mt-2">
        {(ledger.isPending || shop.pending) && <Loading />}
        {ledger.data?.map((l) => (
          <View key={l._id} className="flex-row items-center border-b border-line py-3">
            <View className="flex-1">
              <Text className="text-subhead text-ink">{l.description}</Text>
              <Text className="text-caption2 text-sub">{clock(l.createdAt)}</Text>
            </View>
            <Text
              className={cx(
                'text-subhead font-semibold',
                l.amount < 0 ? 'text-danger' : 'text-brand',
              )}
            >
              {l.amount > 0 ? '+' : ''}
              {l.amount} P
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function BoxScreen() {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const shop = useShopData();
  const { owned, equipped, equippedIds, loaded } = shop;
  const all = useQuery({ queryKey: ['shop', 'all'], queryFn: () => api.shop.items({}) });
  const [tab, setTab] = useState<'전체' | '아바타' | '테마'>('전체');
  const [pick, setPick] = useState<ShopItem | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { equip: eq } = useLocalSearchParams<{ equip?: string }>();
  // 상점에서 '장착하러 가기'로 들어오면 그 아이템을 고른 상태로 연다 (렌더 중 상태 조정)
  const [opened, setOpened] = useState<string>();
  const key = eq && all.data && loaded ? `${eq}:${all.dataUpdatedAt}:${owned.has(eq)}` : undefined;
  if (key && key !== opened) {
    setOpened(key);
    setPick(owned.has(eq!) ? (all.data?.find((i) => i._id === eq) ?? null) : null);
  }
  const items = [BASE_AVATAR, ...(all.data ?? []).filter((i) => owned.has(i._id))].filter(
    (i) => tab === '전체' || (tab === '아바타' ? i.category === 'avatar' : i.category === 'theme'),
  );
  const cur = [BASE_AVATAR, ...(all.data ?? [])].find((i) => i._id === equipped) ?? BASE_AVATAR;
  const isEquipped = (it: ShopItem) => equippedIds.has(it._id) || it._id === equipped;
  const equip = useMutation({
    mutationFn: (it: ShopItem) => {
      if (it._id !== BASE_AVATAR._id && !owned.has(it._id))
        throw new Error('보유한 아이템만 장착할 수 있어요');
      return api.shop.equip(it._id);
    },
    onError: () => setMsg('장착하지 못했어요. 다시 시도해주세요'),
    onSuccess: (_, it) => {
      qc.invalidateQueries({ queryKey: ['my-items'] });
      setPick(null);
      setMsg(`✓ 장착 완료 · ${it.name}`);
    },
  });
  if (shop.error || (all.isError && !all.data))
    return <ShopError retry={() => Promise.all([shop.retry(), all.refetch()])} />;
  if (shop.pending || all.isPending) return <Loading />;
  return (
    <View className="flex-1 bg-white px-5" style={{ paddingTop: insets.top }}>
      <ScrollView className="flex-1" contentContainerClassName="pb-8">
        {msg ? (
          <Toast msg={msg} onClose={() => setMsg(null)} />
        ) : (
          <Pressable onPress={() => router.back()} className="h-12 flex-row items-center pt-2">
            <ChevronLeft size={ICON.md} color={C.ink} />
            <Text className="text-callout font-bold text-ink">보관함</Text>
          </Pressable>
        )}
        <View className="mt-3 h-32 items-center justify-center rounded-2xl bg-cream">
          <ItemPreview item={cur} large />
          <View className="absolute right-3 bottom-3 rounded-full bg-white px-2 py-0.5">
            <Text className="text-caption2 text-ink">현재 아바타</Text>
          </View>
        </View>
        <View className="mt-3 flex-row gap-1">
          {(['전체', '아바타', '테마'] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              className={cx('rounded-lg px-3 py-1.5', tab === t && 'bg-mint')}
            >
              <Text
                className={cx('text-footnote', tab === t ? 'font-semibold text-brand' : 'text-sub')}
              >
                {t}
              </Text>
            </Pressable>
          ))}
        </View>
        {owned.size === 0 ? (
          <View className="mt-14 items-center">
            <Package size={ICON.xl} color={C.brand} />
            <Text className="mt-2 text-subhead font-semibold text-ink">
              아직 보유한 아이템이 없어요
            </Text>
            <Pressable
              onPress={() => router.replace('/shop')}
              className="mt-3 rounded-full bg-ink px-4 py-1.5"
            >
              <Text className="text-footnote text-white">상점 둘러보기</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-2 flex-row flex-wrap justify-between gap-y-2.5">
            {items.map((it) => (
              <Pressable
                key={it._id}
                onPress={() => !isEquipped(it) && setPick(it)}
                className="w-[48.5%] rounded-2xl bg-cream p-2"
              >
                <View className="h-24 items-center justify-center rounded-xl bg-white">
                  <ItemPreview item={it} />
                </View>
                <Text className="mt-2 px-1 text-footnote font-semibold text-ink">{it.name}</Text>
                <View
                  className={cx(
                    'ml-1 mt-0.5 self-start rounded-full px-2 py-0.5',
                    isEquipped(it) ? 'bg-brand' : 'bg-mint',
                  )}
                >
                  <Text
                    className={cx('text-caption2', isEquipped(it) ? 'text-white' : 'text-brand')}
                  >
                    {isEquipped(it) ? '장착중' : '보유중'}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      <Sheet open={!!pick} onClose={() => setPick(null)}>
        {pick && (
          <>
            <View className="h-36 items-center justify-center rounded-2xl bg-cream">
              <ItemPreview item={pick} large />
            </View>
            <View className="mt-3 flex-row items-center justify-between">
              <Text className="text-body font-bold text-ink">{pick.name}</Text>
              <Badge>보유중</Badge>
            </View>
            <Text className="mt-1 text-caption text-sub">{pick.description}</Text>
            <Btn className="mt-4" loading={equip.isPending} onPress={() => equip.mutate(pick)}>
              장착하기
            </Btn>
          </>
        )}
      </Sheet>
    </View>
  );
}
