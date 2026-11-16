import { router } from 'expo-router';
import { render } from '@testing-library/react-native';
import AuthCallback from '../../app/auth/callback';

afterEach(() => jest.clearAllMocks());

const withHistory = (canGoBack: boolean) => {
  (router as unknown as { canGoBack: () => boolean }).canGoBack = () => canGoBack;
};

it('돌아갈 화면이 있으면 그대로 돌아간다', async () => {
  withHistory(true);
  await render(<AuthCallback />);
  expect(router.back).toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it('돌아갈 화면이 없으면 빈 화면에 머물지 않고 로그인으로 간다', async () => {
  withHistory(false);
  await render(<AuthCallback />);
  expect(router.replace).toHaveBeenCalledWith('/(auth)/login');
});
