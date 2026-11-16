import type { ShopItem, Subject } from '@notelink/shared';

// 앱에 원래 들어 있는 데이터(사용자 기록이 아님): 기본 과목 · 상점 상품 · 공휴일.
// 사용자가 만든 것은 모두 store.ts의 DB에 저장된다.

/** 처음 고를 수 있는 기본 과목. 사용자가 '새 과목'으로 더한 것은 DB에 저장된다 */
export const DEFAULT_SUBJECTS: Subject[] = [
  { _id: 's-math', categoryId: null, name: '수학', color: '#3b6e5b', sortOrder: 0, isActive: true },
  { _id: 's-eng', categoryId: null, name: '영어', color: '#c9b98f', sortOrder: 1, isActive: true },
  { _id: 's-sci', categoryId: null, name: '과학', color: '#c9b98f', sortOrder: 2, isActive: true },
  { _id: 's-kor', categoryId: null, name: '국어', color: '#c9b98f', sortOrder: 3, isActive: true },
  { _id: 's-chem', categoryId: null, name: '화학', color: '#c9b98f', sortOrder: 4, isActive: true },
];

/** 상점 상품 목록 (서버가 붙으면 GET /shop/items로 받는다) */
export const SHOP: ShopItem[] = [
  {
    _id: 'saebyeok',
    category: 'avatar',
    name: '새벽 아바타',
    description: '짧은 머리가 깔끔한 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '🧑🏽',
    assetUrl: '🧑🏽',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
    badge: 'NEW',
  },
  {
    _id: 'jihoo',
    category: 'avatar',
    name: '지후 아바타',
    description: '단정한 교복 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👨🏻',
    assetUrl: '👨🏻',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
    badge: 'BEST',
  },
  {
    _id: 'bora',
    category: 'avatar',
    name: '보라 아바타',
    description: '머리를 묶은 발랄한 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👧🏻',
    assetUrl: '👧🏻',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'haneul',
    category: 'avatar',
    name: '하늘 아바타',
    description: '긴 생머리 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👩🏻',
    assetUrl: '👩🏻',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'narae',
    category: 'avatar',
    name: '나래 아바타',
    description: '곱슬머리가 귀여운 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👩🏼‍🦱',
    assetUrl: '👩🏼‍🦱',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'sea',
    category: 'theme',
    name: '바다 테마',
    description: '시원한 파란 물결이 앱 전체를 감싸요.',
    price: 1000,
    avatarStyle: null,
    thumbnailUrl: '🌊',
    assetUrl: '🌊',
    purchaseCount: 0,
    isActive: true,
    isDefault: false,
  },
];
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

/** 국가 공휴일(양력). 음력 공휴일 · 대체 공휴일은 서버의 공공데이터 연동(FR-12-01)으로 받는다 */
export const HOLIDAYS = [
  ['01-01', '신정'],
  ['03-01', '삼일절'],
  ['05-05', '어린이날'],
  ['06-06', '현충일'],
  ['08-15', '광복절'],
  ['10-03', '개천절'],
  ['10-09', '한글날'],
  ['12-25', '성탄절'],
] as const;
