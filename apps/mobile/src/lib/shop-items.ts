import type { ShopItem } from '@notelink/shared';

export const BASE_AVATAR: ShopItem = {
  _id: 'base',
  category: 'avatar',
  name: '기본 아바타',
  description: '기본으로 제공되는 아바타예요.',
  price: 0,
  avatarStyle: 'nice',
  thumbnailUrl: '🧑🏻',
  assetUrl: '🧑🏻',
  purchaseCount: 0,
  isActive: true,
  isDefault: true,
};

/** 보관함 테마 탭의 「기본 바탕」: 고르면 장착한 테마를 벗는다(아바타의 BASE_AVATAR와 같은 가짜 상품) */
export const BASE_THEME: ShopItem = {
  _id: 'base-theme',
  category: 'theme',
  name: '기본 바탕',
  description: '처음 앱의 바탕색으로 돌아가요.',
  price: 0,
  avatarStyle: null,
  thumbnailUrl: '🌫️',
  assetUrl: '🌫️',
  purchaseCount: 0,
  isActive: true,
  isDefault: true,
};
