import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { FindAccountScreen } from '../features/auth/find';
import { LoginScreen } from '../features/auth/auth';
import { api, ApiError } from '../lib/api';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

it('로그인 화면에서 아이디 · 비밀번호 찾기를 연다', async () => {
  await renderScreen(<LoginScreen />);
  await fireEvent.press(screen.getByText('아이디 · 비밀번호 찾기'));
  expect(router.push).toHaveBeenCalledWith('/(auth)/find-account');
});

it('닉네임으로 가린 가입 이메일을 보여 준다', async () => {
  jest.spyOn(api.auth, 'findEmail').mockResolvedValue({ emails: ['e2***@example.com'] });
  await renderScreen(<FindAccountScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('가입할 때 정한 닉네임'), '광합성왕');
  await fireEvent.press(screen.getAllByText('아이디 찾기').at(-1)!);
  expect(await screen.findByText('e2***@example.com')).toBeTruthy();
  expect(api.auth.findEmail).toHaveBeenCalledWith('광합성왕');
});

it('비밀번호 재설정: 인증번호를 받고 새 비밀번호로 바꾼 뒤 로그인으로 돌아간다', async () => {
  const reset = jest.spyOn(api.auth, 'passwordReset').mockResolvedValue(undefined);
  await renderScreen(<FindAccountScreen />);
  await fireEvent.press(screen.getByText('비밀번호 재설정'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  await fireEvent.changeText(await screen.findByPlaceholderText('6자리 숫자'), '123456');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'newpass123');
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), 'newpass12');
  expect(screen.getByText('비밀번호가 서로 달라요')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), 'newpass123');
  await fireEvent.press(screen.getByText('비밀번호 바꾸기'));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(auth)/login',
      params: { email: 'a@b.co' },
    }),
  );
  expect(reset).toHaveBeenCalledWith('a@b.co', '123456', 'newpass123');
});

it('서버에 아직 경로가 없으면(404) 준비 중이라고 안내한다', async () => {
  jest
    .spyOn(api.auth, 'findEmail')
    .mockRejectedValue(new ApiError('NOT_FOUND', 'Cannot POST', 404));
  await renderScreen(<FindAccountScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('가입할 때 정한 닉네임'), '누구');
  await fireEvent.press(screen.getAllByText('아이디 찾기').at(-1)!);
  expect(await screen.findByText(/아직 준비 중이에요/)).toBeTruthy();
});
