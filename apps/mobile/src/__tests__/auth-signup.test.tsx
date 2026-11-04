import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ERROR_CODES } from '@notelink/shared';
import { LoginScreen, SignupScreen, signupError } from '../features/auth/auth';
import { api, ApiError } from '../lib/api';
import { useToast } from '../stores/toast';
import { useAuth } from '../stores/auth';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

async function fill(email: string, pw: string, confirm = pw) {
  await renderScreen(<SignupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), email);
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), pw);
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), confirm);
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('signupError', () => {
  it.each([
    ['', '', '', null],
    ['a@', '', '', '이메일 형식을 확인해 주세요'],
    ['a@b.co', '1234567', '', '비밀번호는 8자 이상이어야 해요'],
    ['a@b.co', '12345678', '12345670', '비밀번호가 서로 달라요'],
    [' a@b.co ', '12345678', '12345678', null],
  ])('%s / %s / %s', (email, pw, confirm, expected) => {
    expect(signupError(email, pw, confirm)).toBe(expected);
  });
});

it('입력이 맞지 않으면 안내하고 가입 요청을 보내지 않는다', async () => {
  const signup = jest.spyOn(api.auth, 'emailSignup');
  await fill('new@test.com', '12345678', '00000000');
  expect(screen.getByText('비밀번호가 서로 달라요')).toBeTruthy();
  await fireEvent.press(screen.getByText('가입하기'));
  expect(signup).not.toHaveBeenCalled();
});

it('가입하면 앞뒤 공백을 뺀 이메일로 요청하고 약관 동의로 넘어간다', async () => {
  const user = await api.me.get();
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: { ...user, _id: 'new' } });
  useAuth.setState({ onboarded: false });
  await fill(' new@test.com ', '12345678');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  expect(signup).toHaveBeenCalledWith('new@test.com', '12345678');
});

it('이미 있는 이메일이면 로그인으로 돌아갈 길을 보여 주고, 이메일을 고치면 안내를 지운다', async () => {
  jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValue(new ApiError(ERROR_CODES.EMAIL_TAKEN, '이미 가입한 이메일이에요', 409));
  await fill('old@test.com', '12345678');
  await fireEvent.press(screen.getByText('가입하기'));
  expect(await screen.findByText('이미 가입한 이메일이에요')).toBeTruthy();
  await fireEvent.press(screen.getByText('로그인하기'));
  expect(router.back).toHaveBeenCalled();
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'other@test.com');
  expect(screen.queryByText('이미 가입한 이메일이에요')).toBeNull();
});

it('그 밖의 실패는 입력을 유지하고 안내한다', async () => {
  jest.spyOn(api.auth, 'emailSignup').mockRejectedValue(new Error('네트워크'));
  await fill('new@test.com', '12345678');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(useToast.getState().msg).toContain('가입하지 못했어요'));
  expect(screen.getByDisplayValue('new@test.com')).toBeTruthy();
});

it('로그인 시트에서 회원가입으로 갈 수 있다', async () => {
  await renderScreen(<LoginScreen />);
  await fireEvent.press(screen.getByText('이메일로 시작하기'));
  await fireEvent.press(await screen.findByText(/계정이 없나요/));
  expect(router.push).toHaveBeenCalledWith('/(auth)/signup');
});
