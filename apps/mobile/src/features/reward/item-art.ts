import type { ImageSourcePropType } from 'react-native';
import type { ShopItem } from '@notelink/shared';
import { themeOf } from '@/lib/shop-themes';
import { BASE_THEME } from '@/lib/shop-items';
import { C } from '@/theme';
import { accessoryId } from '../tutor/accessories';
import { avatarModel } from '../tutor/buddy';

/**
 * 상점 썸네일: 3D 아바타 · 치장을 앱과 같은 코드로 미리 그린 그림(scripts/item-thumbs가 굽는다).
 * 목록에 GLView를 여러 개 띄우면 iOS GL 컨텍스트 한도 · 성능 문제가 있어 그림을 쓴다
 */
const ART: Record<string, ImageSourcePropType> = {
  base: require('../../../assets/items/base.png'),
  saebyeok: require('../../../assets/items/saebyeok.png'),
  jihoo: require('../../../assets/items/jihoo.png'),
  bora: require('../../../assets/items/bora.png'),
  haneul: require('../../../assets/items/haneul.png'),
  narae: require('../../../assets/items/narae.png'),
  roundGlasses: require('../../../assets/items/roundGlasses.png'),
  sunglasses: require('../../../assets/items/sunglasses.png'),
  beanie: require('../../../assets/items/beanie.png'),
  gradCap: require('../../../assets/items/gradCap.png'),
  redScarf: require('../../../assets/items/redScarf.png'),
};

/** 테마는 바탕색 견본, 아바타 · 치장은 미리 그린 그림. 모르는 상품은 null(상품 그림 글자로 대신) */
export function itemArt(
  item: ShopItem,
): { swatch: string } | { image: ImageSourcePropType } | null {
  if (item._id === BASE_THEME._id) return { swatch: C.canvas };
  if (item.category === 'theme') {
    const t = themeOf(item._id);
    return t ? { swatch: t.canvas } : null;
  }
  const id = item.category === 'avatar' ? avatarModel(item._id, [item]) : accessoryId(item._id);
  // 모르는 아바타는 avatarModel이 기본 얼굴을 돌려주지만, 썸네일은 그 상품 그림을 그대로 둔다
  const known = item.category === 'avatar' ? id !== 'base' || item.isDefault : !!id;
  return known && id && ART[id] ? { image: ART[id] } : null;
}
