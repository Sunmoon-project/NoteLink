import { Text } from 'react-native';
import '../test-utils';
import { render, screen } from '@testing-library/react-native';
import { Sheet } from '../components/ui';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

afterEach(() => {
  globalThis.mockFocused = undefined;
});

it('다른 화면으로 옮겨 가면 열린 시트를 숨기고, 닫기(onClose)는 부르지 않는다', async () => {
  const onClose = jest.fn();
  const view = await render(
    <Sheet open onClose={onClose}>
      <Text>상점 상자</Text>
    </Sheet>,
  );
  expect(screen.getByText('상점 상자')).toBeTruthy();
  globalThis.mockFocused = false;
  await view.rerender(
    <Sheet open onClose={onClose}>
      <Text>상점 상자</Text>
    </Sheet>,
  );
  expect(screen.queryByText('상점 상자')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
