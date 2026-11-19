import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import Animated, { FadeIn, FadeInUp, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Frown,
  Heart,
  Package,
  ShoppingBasket,
  X,
} from 'lucide-react-native';
import { ERROR_CODES, type ShopItem, type UserItem } from '@notelink/shared';
import { api, ApiError, NetworkError } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { clock } from '@/lib/dates';
import { BASE_AVATAR, BASE_THEME } from '@/lib/shop-items';
import { themeOf } from '@/lib/shop-themes';
import {
  Alert,
  Badge,
  Btn,
  Canvas,
  Dialog,
  LIST_LAYOUT,
  Loading,
  Roll,
  Sheet,
  Two,
  cx,
} from '@/components/ui';
import { C, ICON, MOTION } from '@/theme';
import { ACCESSORIES, accessoryId } from '../tutor/accessories';
import { itemArt } from './item-art';
import { Avatar3D } from '../tutor/avatar3d';
import { avatarModel, useEquippedAccessories, useEquippedAvatar } from '../tutor/buddy';

// p.91~95 상점 · 정렬 · 상세 · 구매 · 포인트 내역 · 보관함 / p.101 구매 중 연결 끊김

type Sort = 'latest' | 'price' | 'popular';
/** 아바타 선생님 치장(모자 · 안경 · 목도리). 상점 · 보관함에서는 「치장」 탭 하나로 묶는다 */
const isDress = (i: ShopItem) =>
  i.category === 'hat' || i.category === 'glasses' || i.category === 'scarf';
const inTab = (i: ShopItem, tab: string) =>
  tab === '전체' ||
  (tab === '아바타'
    ? i.category === 'avatar'
    : tab === '치장'
      ? isDress(i)
      : i.category === 'theme');
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
      entering={FadeInUp.duration(MOTION.exit)}
      className="mt-2 flex-row items-center rounded-xl bg-ink px-4 py-2.5"
    >
      <CircleCheck size={ICON.sm} color="#fff" />
      <Text className="ml-2 flex-1 text-footnote font-semibold text-white">{msg}</Text>
      <Pressable accessibilityLabel="닫기" onPress={onClose} hitSlop={10}>
        <X size={ICON.sm} color="#fff" />
      </Pressable>
    </Animated.View>
  );
}

/** 상품 그림: 이미지 주소면 그림으로, 아니면 이모지 글자로(small은 아바타 선생님 고르기 칸 크기) */
/** 상세 창 · 보관함 「현재 아바타」 미리보기: 아바타는 선생님이 될 3D 얼굴로, 그 밖의 상품은 그림으로 */
/** 지금 내 선생님 모습(장착 아바타의 3D 모델 + 장착 치장). 시트가 열릴 때 조회가 새로 붙지 않게 화면에서 읽는다 */
type Look = { face: string; worn: string[] };
const useLook = (): Look => ({ face: useEquippedAvatar(), worn: useEquippedAccessories() });
/** 판매가 끝나 상품 목록에 없는 보유 치장: 보관함에 남겨 벗을 수 있게 이름만 채운 상품으로 */
const goneDress = (u: UserItem): ShopItem | null => {
  const a = ACCESSORIES[accessoryId(u.itemId) ?? ''];
  if (!a || !u.isOwned) return null;
  return {
    _id: u.itemId,
    category: a.slot,
    name: a.name,
    description: '판매가 끝난 치장이에요.',
    price: 0,
    avatarStyle: null,
    thumbnailUrl: null,
    assetUrl: '',
    purchaseCount: 0,
    isActive: false,
    isDefault: false,
  };
};

function DetailPreview({
  item,
  look: { face, worn },
  asWorn = false,
  background = C.fill,
  size = 128,
}: {
  item: ShopItem;
  look: Look;
  /** 보관함 「현재 아바타」처럼 지금 실제 모습(장착 치장 포함). 아니면 그 상품 하나만 입혀 본다 */
  asWorn?: boolean;
  background?: string;
  size?: number;
}) {
  // 테마는 그 바탕색 위 미니 화면 모형(기본 바탕은 원래 바탕색)
  const theme =
    item._id === BASE_THEME._id
      ? { canvas: C.canvas }
      : item.category === 'theme'
        ? themeOf(item._id)
        : null;
  if (theme) return <ThemePreview name={item.name} canvas={theme.canvas} />;
  // 상품 미리보기는 그 상품만: 치장은 지금 아바타에 그 치장 하나, 아바타는 치장 없이
  const dress = isDress(item) ? accessoryId(item._id) : null;
  if (item.category !== 'avatar' && !dress) return <ItemPreview item={item} large />;
  return (
    <View accessibilityLabel={`${item.name} 3D 미리보기`}>
      {/* 상자와 같은 색으로 칠해 네모난 3D 바탕이 보이지 않게 */}
      <Avatar3D
        mood="idle"
        avatarId={dress ? face : avatarModel(item._id, [item])}
        accessories={asWorn ? worn : dress ? [dress] : []}
        size={size}
        background={background}
      />
    </View>
  );
}

/** 테마 미리보기: 그 바탕색 위에 흰 카드 두 줄 + 탭바를 올린 작은 화면 모형 */
function ThemePreview({ name, canvas }: { name: string; canvas: string }) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name} 바탕 미리보기`}
      className="h-32 w-20 overflow-hidden rounded-xl p-2"
      style={{ backgroundColor: canvas }}
    >
      <View className="h-6 rounded-xl bg-white" />
      <View className="mt-1.5 h-10 rounded-xl bg-white" />
      <View className="absolute right-0 bottom-0 left-0 h-5 flex-row items-center justify-around bg-white">
        {[0, 1, 2].map((i) => (
          <View key={i} className={cx('h-1.5 w-1.5 rounded-full', i ? 'bg-line' : 'bg-brand')} />
        ))}
      </View>
    </View>
  );
}

export function ItemPreview({
  item,
  large = false,
  small = false,
}: {
  item: ShopItem;
  large?: boolean;
  small?: boolean;
}) {
  const size = small ? 32 : large ? 96 : 64;
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
  const art = itemArt(item);
  if (art && 'swatch' in art)
    // 바탕색 견본. 흰 카드 위에서도 보이게 얇은 테두리
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={label}
        className="rounded-2xl border border-line"
        style={{ width: size, height: size, backgroundColor: art.swatch }}
      />
    );
  if (art)
    return (
      <Image
        accessibilityRole="image"
        accessibilityLabel={label}
        source={art.image}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
    );
  return (
    <View accessibilityLabel={label}>
      {item.thumbnailUrl ? (
        <Text className={small ? 'text-title1' : large ? 'text-display-lg' : 'text-display'}>
          {item.thumbnailUrl}
        </Text>
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
  // 테마는 판매 목록이 아니라 내 아이템에서 본다(판매가 끝난 테마도 벗을 수 있게)
  const themes = (mine.data ?? []).filter((u) => u.isOwned && u.itemCategory === 'theme');
  return {
    mine: mine.data ?? [],
    wornThemeId: themes.find((u) => u.isEquipped)?.itemId ?? null,
    hasTheme: themes.length > 0,
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
  const [tab, setTab] = useState<'전체' | '아바타' | '치장' | '테마' | '찜'>('전체');
  const [sort, setSort] = useState<Sort>('latest');
  const items = useQuery({
    queryKey: ['shop', tab, sort],
    queryFn: () =>
      api.shop.items({
        // 치장은 종류가 셋이라 전체를 받아 앱에서 거른다
        category: tab === '아바타' ? 'avatar' : tab === '테마' ? 'theme' : undefined,
        sort,
      }),
  });
  const shop = useShopData();
  const look = useLook();
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
      setMsg(`구매 완료 · ${it.name}`);
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
    tab === '찜'
      ? (items.data ?? []).filter((i) => wished.has(i._id))
      : (items.data ?? []).filter((i) => inTab(i, tab));
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
            {/* 사고 나면 잔액이 자리별로 굴러 내려간다 */}
            {shop.pending ? (
              <Text className="text-headline font-bold text-ink">확인 중…</Text>
            ) : (
              <Roll
                value={`${points.toLocaleString()} P`}
                className="text-headline font-bold text-ink"
              />
            )}
          </Pressable>
          {(shop.pending || items.isPending) && <Loading />}
          <View className="mt-4 flex-row gap-1">
            {(['전체', '아바타', '치장', '테마', '찜'] as const).map((t) => (
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
            <View className="mt-5 flex-row flex-wrap justify-between gap-y-5">
              {list.map((it) => (
                <View key={it._id} className="w-[47.5%] rounded-card bg-white p-3">
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
                    <Text className="mt-2.5 px-1 text-footnote font-semibold text-ink">
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
                <DetailPreview item={detail} look={look} />
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
    <Canvas>
      <ScrollView
        className="flex-1"
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
            <Animated.View
              key={l._id}
              layout={LIST_LAYOUT}
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <View key={l._id} className="flex-row items-center border-b border-fill py-4">
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
            </Animated.View>
          ))}
        </View>
      </ScrollView>
    </Canvas>
  );
}

export function BoxScreen() {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const shop = useShopData();
  const look = useLook();
  const { owned, equipped, equippedIds, loaded, wornThemeId, hasTheme } = shop;
  const all = useQuery({ queryKey: ['shop', 'all'], queryFn: () => api.shop.items({}) });
  const [tab, setTab] = useState<'전체' | '아바타' | '치장' | '테마'>('전체');
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
  const onSale = all.data ?? [];
  // 판매가 끝나 목록에서 빠진 치장도 내 아이템 기준으로 남겨 벗을 수 있게
  const gone = shop.mine
    .filter((u) => !onSale.some((i) => i._id === u.itemId))
    .map(goneDress)
    .filter((i): i is ShopItem => !!i);
  const mineList = [...onSale.filter((i) => owned.has(i._id)), ...gone];
  // 테마를 하나라도 가졌을 때만 「기본 바탕」(= 장착한 테마 벗기)을 둔다
  const items = [BASE_AVATAR, ...(hasTheme ? [BASE_THEME] : []), ...mineList].filter((i) =>
    inTab(i, tab),
  );
  const cur = [BASE_AVATAR, ...(all.data ?? [])].find((i) => i._id === equipped) ?? BASE_AVATAR;
  const isEquipped = (it: ShopItem) =>
    it._id === BASE_THEME._id ? !wornThemeId : equippedIds.has(it._id) || it._id === equipped;
  // 장착 중인 치장은 시트에서 벗는다
  const takeOff = (it: ShopItem) => isDress(it) && isEquipped(it);
  // 벗기인지는 누른 순간에 정해 넘긴다(완료 뒤 다시 계산하면 그새 갱신된 목록 때문에 문구가 뒤바뀔 수 있다)
  const equip = useMutation({
    mutationFn: ({ it, off }: { it: ShopItem; off: boolean }) => {
      // 기본 바탕 = 장착한 테마 벗기
      if (it._id === BASE_THEME._id)
        return wornThemeId ? api.shop.unequip(wornThemeId) : Promise.resolve();
      if (it._id !== BASE_AVATAR._id && !owned.has(it._id))
        throw new Error('보유한 아이템만 장착할 수 있어요');
      return off ? api.shop.unequip(it._id) : api.shop.equip(it._id);
    },
    onError: (_, { off }) =>
      setMsg(off ? '벗지 못했어요. 다시 시도해주세요' : '장착하지 못했어요. 다시 시도해주세요'),
    onSuccess: (_, { it, off }) => {
      qc.invalidateQueries({ queryKey: ['my-items'] });
      setPick(null);
      setMsg(off ? `벗기 완료 · ${it.name}` : `장착 완료 · ${it.name}`);
    },
  });
  if (shop.error || (all.isError && !all.data))
    return <ShopError retry={() => Promise.all([shop.retry(), all.refetch()])} />;
  if (shop.pending || all.isPending) return <Loading />;
  return (
    <Canvas>
      <View className="flex-1 px-5" style={{ paddingTop: insets.top }}>
        <ScrollView className="flex-1" contentContainerClassName="pb-8">
          {msg ? (
            <Toast msg={msg} onClose={() => setMsg(null)} />
          ) : (
            <Pressable onPress={() => router.back()} className="h-12 flex-row items-center pt-2">
              <ChevronLeft size={ICON.md} color={C.ink} />
              <Text className="text-callout font-bold text-ink">보관함</Text>
            </Pressable>
          )}
          <View className="mt-3 h-32 items-center justify-center overflow-hidden rounded-2xl bg-mint">
            {/* 장착한 아바타는 선생님이 될 3D 얼굴로 (상자 bg-mint와 같은 바탕, 상자 안에 들어가는 크기) */}
            <DetailPreview item={cur} look={look} asWorn background={C.mint} size={112} />
            <View className="absolute right-3 bottom-3 rounded-full bg-white px-2 py-0.5">
              <Text className="text-caption2 text-ink">현재 아바타</Text>
            </View>
          </View>
          <View className="mt-3 flex-row gap-1">
            {(['전체', '아바타', '치장', '테마'] as const).map((t) => (
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
          {owned.size === 0 ? (
            <View className="mt-14 items-center">
              <Package size={ICON.xl} color={C.brand} />
              <Text className="mt-2 text-subhead font-semibold text-ink">
                아직 보유한 아이템이 없어요
              </Text>
              <Pressable
                onPress={() => router.replace('/shop')}
                className="mt-3 rounded-full bg-brand px-4 py-1.5"
              >
                <Text className="text-footnote text-white">상점 둘러보기</Text>
              </Pressable>
            </View>
          ) : (
            <View className="mt-2 flex-row flex-wrap justify-between gap-y-2.5">
              {items.map((it) => (
                <Pressable
                  key={it._id}
                  onPress={() => (!isEquipped(it) || isDress(it)) && setPick(it)}
                  accessibilityHint={takeOff(it) ? '눌러서 벗을 수 있어요' : undefined}
                  className="w-[47.5%] rounded-card bg-white p-2.5"
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
              <View className="h-36 items-center justify-center rounded-2xl bg-fill">
                <DetailPreview item={pick} look={look} />
              </View>
              <View className="mt-3 flex-row items-center justify-between">
                <Text className="text-body font-bold text-ink">{pick.name}</Text>
                <Badge>보유중</Badge>
              </View>
              <Text className="mt-1 text-caption text-sub">{pick.description}</Text>
              <Btn
                className="mt-4"
                kind={takeOff(pick) ? 'outline' : 'primary'}
                loading={equip.isPending}
                onPress={() => equip.mutate({ it: pick, off: takeOff(pick) })}
              >
                {takeOff(pick) ? '벗기' : '장착하기'}
              </Btn>
            </>
          )}
        </Sheet>
      </View>
    </Canvas>
  );
}
