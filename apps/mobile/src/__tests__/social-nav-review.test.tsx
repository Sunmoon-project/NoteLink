import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SocialDrawer } from '../features/social/drawer';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

it('친구 추가로 갈 때 드로어를 닫고 뒤로 가지 않아 홈 화면이 비치지 않는다', async () => {
  const onClose = jest.fn();
  const replace = jest.spyOn(router, 'replace').mockImplementation(() => {});
  const push = jest.spyOn(router, 'push').mockImplementation(() => {});
  await renderScreen(<SocialDrawer open onClose={onClose} />);
  await fireEvent.press(await screen.findByText(/친구 추가/));
  expect(replace).toHaveBeenCalledWith('/friend-add');
  expect(push).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
