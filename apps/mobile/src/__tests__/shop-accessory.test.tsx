import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { UserItem } from '@notelink/shared';
import { BoxScreen, ShopScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
// 3D(GL)는 기기에서만: 어떤 얼굴에 무엇을 씌우는지만 글로 본다
jest.mock('../features/tutor/avatar3d', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    Avatar3D: ({ avatarId, accessories }: { avatarId: string; accessories?: string[] }) => (
      <T>{`3D:${avatarId}+${(accessories ?? []).join(',')}`}</T>
    ),
  };
});

const own = (itemId: string, itemCategory: UserItem['itemCategory'], isEquipped = false) =>
  ({
    _id: `ui-${itemId}`,
    itemId,
    itemCategory,
    isOwned: true,
    isWished: false,
    isEquipped,
    acquiredAt: null,
  }) as UserItem;

afterEach(() => jest.restoreAllMocks());

describe('상점 치장', () => {
  it('「치장」 탭에 모자 · 안경 · 목도리 5개가 보인다', async () => {
    await renderScreen(<ShopScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    for (const name of ['동그란 안경', '선글라스', '털모자', '학사모', '빨간 목도리'])
      expect(await screen.findByText(name)).toBeTruthy();
    expect(screen.queryByText('바다 테마')).toBeNull();
    expect(screen.queryByText('보라 아바타')).toBeNull();
  });

  it('치장 상세는 내 선생님(장착 아바타 + 다른 칸 장착 치장)에 이 치장을 씌워 보이고, 같은 칸 기존 것은 뺀다', async () => {
    jest
      .spyOn(api.shop, 'myItems')
      .mockResolvedValue([
        own('bora', 'avatar', true),
        own('roundGlasses', 'glasses', true),
        own('redScarf', 'scarf', true),
      ]);
    await renderScreen(<ShopScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    await fireEvent.press(await screen.findByText('선글라스'));
    expect(await screen.findByLabelText('선글라스 3D 미리보기')).toBeTruthy();
    expect(screen.getByText('3D:bora+redScarf,sunglasses')).toBeTruthy();
  });

  it('아바타 상세도 지금 장착한 치장을 씌워 보인다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('beanie', 'hat', true)]);
    await renderScreen(<ShopScreen />);
    await fireEvent.press((await screen.findAllByText('지후 아바타'))[0]!);
    expect(await screen.findByText('3D:jihoo+beanie')).toBeTruthy();
  });
});

describe('보관함 치장 · 기본 바탕', () => {
  it('장착 중인 치장을 누르면 「벗기」로 벗긴다', async () => {
    jest
      .spyOn(api.shop, 'myItems')
      .mockResolvedValue([own('beanie', 'hat', true), own('sunglasses', 'glasses')]);
    const unequip = jest.spyOn(api.shop, 'unequip').mockResolvedValue(undefined);
    const equip = jest.spyOn(api.shop, 'equip');
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    await fireEvent.press(await screen.findByText('털모자'));
    await fireEvent.press(await screen.findByText('벗기'));
    await waitFor(() => expect(unequip).toHaveBeenCalledWith('beanie'));
    expect(equip).not.toHaveBeenCalled();
  });

  it('테마를 보유하면 테마 탭 맨 앞에 「기본 바탕」이 있고, 고르면 장착한 테마를 벗긴다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('sea', 'theme', true)]);
    const unequip = jest.spyOn(api.shop, 'unequip').mockResolvedValue(undefined);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('테마'));
    const names = (await screen.findAllByText(/기본 바탕|바다 테마/)).map((t) =>
      String(t.props.children),
    );
    expect(names[0]).toBe('기본 바탕');
    await fireEvent.press(screen.getByText('기본 바탕'));
    await fireEvent.press(await screen.findByText('장착하기'));
    await waitFor(() => expect(unequip).toHaveBeenCalledWith('sea'));
  });

  it('기본 아바타로 돌아갈 때는 벗기 API를 부르지 않는다(서버 벗기는 base를 모른다)', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('bora', 'avatar', true)]);
    const unequip = jest.spyOn(api.shop, 'unequip');
    const equip = jest.spyOn(api.shop, 'equip').mockResolvedValue(undefined);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('기본 아바타'));
    await fireEvent.press(await screen.findByText('장착하기'));
    await waitFor(() => expect(equip).toHaveBeenCalledWith('base'));
    expect(unequip).not.toHaveBeenCalled();
  });
});
