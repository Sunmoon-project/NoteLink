import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { C } from '@/theme';

/** 상점 테마 → 앱 바탕(Canvas) 색. 글자 · 카드색은 그대로 두므로 바탕 위 글자 대비가 4.5:1 이상인 연한 색만 */
export type Theme = { canvas: string };
export const THEMES: Record<string, Theme> = {
  sea: { canvas: C.sea },
};
/** 서버 상품은 id가 ObjectId라 고정 시드 id(apps/api shop-seed.ts idOf)로도 찾는다 */
const SEED_IDS: Record<string, string> = { '6e6f74656c696e6b73680006': 'sea' };

export const themeOf = (itemId: string | undefined): Theme | null =>
  (itemId && THEMES[SEED_IDS[itemId] ?? itemId]) || null;

/** 장착한 테마. 로그인 전 · 보관함 조회 실패면 null(기본 바탕) */
export function useEquippedTheme(enabled = true): Theme | null {
  const signedIn = useAuth((s) => !!s.userId);
  const mine = useQuery({
    queryKey: ['my-items'],
    queryFn: () => api.shop.myItems(),
    enabled: enabled && signedIn,
    // Canvas가 붙을 때마다 다시 묻지는 않는다(다른 화면 · 장착 후 무효화가 새로 받는다)
    staleTime: Infinity,
    // 조회가 실패한 채면 화면의 「다시 시도」에 맡긴다(바탕이 대신 다시 묻지 않게)
    retryOnMount: false,
  });
  return themeOf(mine.data?.find((u) => u.isEquipped && u.itemCategory === 'theme')?.itemId);
}
