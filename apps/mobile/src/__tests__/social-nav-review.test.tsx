import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SocialDrawer } from '../features/social/drawer';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// 사용자 신고: 친구 창에서 하위 화면(친구 추가 · 받은 요청 · 채팅)으로 갔다가 뒤로 가면 친구 창이 아니라 홈으로 갔다.
// 친구 창(/friends)을 하위 화면으로 바꿔치기(replace)해 스택에 남지 않았다 → 위에 쌓아(push) 뒤로 가면 친구 창이 다시 보인다.
// 드로어는 닫지 않으므로 사이에 홈이 비치지도 않는다
it.each([
  [/친구 추가/, '/friend-add'],
  ['받은 친구 요청', '/requests'],
])('친구 창에서 %s 화면으로 가도 친구 창을 남긴 채 위에 쌓는다', async (label, href) => {
  const onClose = jest.fn();
  const replace = jest.spyOn(router, 'replace').mockImplementation(() => {});
  const push = jest.spyOn(router, 'push').mockImplementation(() => {});
  await renderScreen(<SocialDrawer open onClose={onClose} />);
  await fireEvent.press(await screen.findByText(label));
  expect(push).toHaveBeenCalledWith(href);
  expect(replace).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  push.mockRestore();
  replace.mockRestore();
});
