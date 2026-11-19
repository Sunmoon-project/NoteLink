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

  it('치장 상세는 지금 쓰는 아바타에 이 치장 하나만 씌워 보인다(이미 낀 다른 치장은 빼고)', async () => {
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
    expect(screen.getByText('3D:bora+sunglasses')).toBeTruthy();
  });

  it('아바타 상세는 치장 없이 그 아바타만 보인다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('beanie', 'hat', true)]);
    await renderScreen(<ShopScreen />);
    await fireEvent.press((await screen.findAllByText('지후 아바타'))[0]!);
    expect(await screen.findByText('3D:jihoo+')).toBeTruthy();
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
    // 원래 바탕색 위 미니 화면 모형으로 미리 본다
    expect(await screen.findByLabelText('기본 바탕 바탕 미리보기')).toBeTruthy();
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

  it('장착한 테마가 판매 종료돼 목록에 없어도 「기본 바탕」으로 벗을 수 있다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('gone-theme', 'theme', true)]);
    const unequip = jest.spyOn(api.shop, 'unequip').mockResolvedValue(undefined);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('테마'));
    await fireEvent.press(await screen.findByText('기본 바탕'));
    await fireEvent.press(await screen.findByText('장착하기'));
    await waitFor(() => expect(unequip).toHaveBeenCalledWith('gone-theme'));
    expect(await screen.findByText('장착 완료 · 기본 바탕')).toBeTruthy();
  });

  it('치장을 벗으면 「벗기 완료」라고 알린다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own('beanie', 'hat', true)]);
    jest.spyOn(api.shop, 'unequip').mockResolvedValue(undefined);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    await fireEvent.press(await screen.findByText('털모자'));
    await fireEvent.press(await screen.findByText('벗기'));
    expect(await screen.findByText('벗기 완료 · 털모자')).toBeTruthy();
  });

  it('장착 중인 치장 카드는 누르면 벗을 수 있다고 알려 준다', async () => {
    jest
      .spyOn(api.shop, 'myItems')
      .mockResolvedValue([own('beanie', 'hat', true), own('sunglasses', 'glasses')]);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    expect(await screen.findByHintText('눌러서 벗을 수 있어요')).toBeTruthy();
    expect(screen.getAllByHintText('눌러서 벗을 수 있어요')).toHaveLength(1);
  });

  it('보관함 「현재 아바타」는 지금 실제 모습(장착 치장 포함), 고른 치장 시트는 그 치장 하나만', async () => {
    jest
      .spyOn(api.shop, 'myItems')
      .mockResolvedValue([
        own('bora', 'avatar', true),
        own('beanie', 'hat', true),
        own('redScarf', 'scarf', true),
        own('sunglasses', 'glasses'),
      ]);
    await renderScreen(<BoxScreen />);
    expect(await screen.findByText('3D:bora+beanie,redScarf')).toBeTruthy();
    await fireEvent.press(await screen.findByText('치장'));
    await fireEvent.press(await screen.findByText('선글라스'));
    expect(await screen.findByText('3D:bora+sunglasses')).toBeTruthy();
  });

  it('판매가 끝나 목록에 없는 치장도 장착 중이면 보관함에 남아 벗을 수 있다', async () => {
    const gone = '6e6f74656c696e6b73680009'; // 서버의 털모자(판매 종료로 상품 목록에서 빠짐)
    jest.spyOn(api.shop, 'myItems').mockResolvedValue([own(gone, 'hat', true)]);
    const unequip = jest.spyOn(api.shop, 'unequip').mockResolvedValue(undefined);
    await renderScreen(<BoxScreen />);
    await fireEvent.press(await screen.findByText('치장'));
    await fireEvent.press(await screen.findByText('털모자'));
    await fireEvent.press(await screen.findByText('벗기'));
    await waitFor(() => expect(unequip).toHaveBeenCalledWith(gone));
  });
});
