import { screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { ShopItem } from '@notelink/shared';
import { ItemPreview } from '../features/reward/shop';
import { SHOP } from '../lib/local/catalog';
import { BASE_AVATAR, BASE_THEME } from '../lib/shop-items';
import { renderScreen } from '../test-utils';
import { C } from '../theme';

const item = (id: string) => SHOP.find((i) => i._id === id)!;
const bg = (label: string) =>
  StyleSheet.flatten(screen.getByLabelText(label).props.style as StyleProp<ViewStyle>)
    ?.backgroundColor;

describe('상점 썸네일: 이모지 대신 실제 모습', () => {
  it.each([
    ['bora', '보라 아바타'],
    ['narae', '나래 아바타'],
    ['beanie', '털모자'],
    ['sunglasses', '선글라스'],
    ['redScarf', '빨간 목도리'],
  ])('%s는 3D와 같은 모습의 그림(PNG)이고 이모지 글자는 없다', async (id, name) => {
    const it = item(id);
    await renderScreen(<ItemPreview item={it} />);
    const img = screen.getByLabelText(`${name} 미리보기`);
    expect(img.props.source).toBeTruthy();
    expect(screen.queryByText(it.thumbnailUrl!)).toBeNull();
  });

  it('기본 아바타도 3D 얼굴 그림', async () => {
    await renderScreen(<ItemPreview item={BASE_AVATAR} />);
    expect(screen.getByLabelText('기본 아바타 미리보기').props.source).toBeTruthy();
    expect(screen.queryByText(BASE_AVATAR.thumbnailUrl!)).toBeNull();
  });

  it('서버 상품(고정 시드 id · 같은 이름의 아바타)도 같은 그림', async () => {
    const server = (i: ShopItem, _id: string): ShopItem => ({ ...i, _id });
    await renderScreen(<ItemPreview item={server(item('beanie'), '6e6f74656c696e6b73680009')} />);
    expect(screen.getByLabelText('털모자 미리보기').props.source).toBeTruthy();
    await renderScreen(<ItemPreview item={server(item('bora'), '6e6f74656c696e6b73680003')} />);
    expect(screen.getByLabelText('보라 아바타 미리보기').props.source).toBeTruthy();
  });

  it('테마는 실제 바탕색 견본(기본 바탕은 원래 바탕색)', async () => {
    await renderScreen(<ItemPreview item={item('sea')} />);
    expect(bg('바다 테마 미리보기')).toBe(C.sea);
    expect(screen.queryByText('🌊')).toBeNull();
    await renderScreen(<ItemPreview item={BASE_THEME} />);
    expect(bg('기본 바탕 미리보기')).toBe(C.canvas);
  });

  it('모르는 상품은 지금처럼 상품 그림 글자로 대신한다', async () => {
    await renderScreen(
      <ItemPreview
        item={{
          ...item('beanie'),
          _id: 'new-thing',
          name: '새 상품',
          category: 'hat',
          thumbnailUrl: '🎩',
        }}
      />,
    );
    expect(screen.getByText('🎩')).toBeTruthy();
  });
});
