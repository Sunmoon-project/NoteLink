import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ERROR_CODES } from '@notelink/shared';
import { LoginScreen, ProfileSetupScreen, SignupScreen, signupError } from '../features/auth/auth';
import { api, ApiError } from '../lib/api';
import { useToast } from '../stores/toast';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
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

it('가입하면 바로 로그인시키지 않고, 가입한 이메일을 채운 로그인으로 보낸다', async () => {
  const signup = jest.spyOn(api.auth, 'emailSignup').mockResolvedValue(undefined);
  await fill(' new@test.com ', '12345678');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(auth)/login',
      params: { email: 'new@test.com' },
    }),
  );
  expect(signup).toHaveBeenCalledWith('new@test.com', '12345678');
  expect(useAuth.getState().tokens).toBeFalsy();
});

it('가입 후 돌아온 로그인은 이메일이 채워진 창을 연다', async () => {
  setParams({ email: 'new@test.com' });
  await renderScreen(<LoginScreen />);
  expect(await screen.findByDisplayValue('new@test.com')).toBeTruthy();
  setParams({});
});

it('새 계정은 로그인하면 약관을 거쳐 초기 설정으로 간다', async () => {
  const user = await api.me.get();
  jest
    .spyOn(api.auth, 'emailLogin')
    .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user: { ...user, _id: 'new' } });
  await renderScreen(<LoginScreen />);
  await fireEvent.press(screen.getByText('이메일로 로그인'));
  await fireEvent.changeText(await screen.findByPlaceholderText('you@example.com'), 'n@test.com');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), '12345678');
  await fireEvent.press(screen.getByText('로그인'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
});

it('초기 설정은 미리 고른 값이 없고, 닉네임과 학습자 유형을 골라야 시작할 수 있다', async () => {
  const update = jest.spyOn(api.me, 'update');
  await renderScreen(<ProfileSetupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('노트러버'), '한결');
  await fireEvent.press(screen.getByText('시작하기'));
  expect(update).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('대학생'));
  await fireEvent.press(screen.getByText('시작하기'));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      nickname: '한결',
      learnerType: 'university',
      interestCategoryIds: [],
    }),
  );
});

it('이미 있는 이메일이면 로그인으로 돌아갈 길을 보여 주고, 이메일을 고치면 안내를 지운다', async () => {
  jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValue(new ApiError(ERROR_CODES.EMAIL_TAKEN, '이미 가입한 이메일이에요', 409));
  await fill('old@test.com', '12345678');
  await fireEvent.press(screen.getByText('가입하기'));
  expect(await screen.findByText('이미 가입한 이메일이에요')).toBeTruthy();
  await fireEvent.press(screen.getByText('로그인하기'));
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/(auth)/login',
    params: { email: 'old@test.com' },
  });
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

it('로그인 화면에서 회원가입으로 갈 수 있다', async () => {
  await renderScreen(<LoginScreen />);
  await fireEvent.press(screen.getByText(/계정이 없나요/));
  expect(router.push).toHaveBeenCalledWith('/(auth)/signup');
});

it('회원가입 화면에도 간편 로그인 버튼이 있다', async () => {
  await renderScreen(<SignupScreen />);
  for (const label of ['카카오로 시작하기', '네이버로 시작하기', 'Google로 시작하기'])
    expect(screen.getByText(label)).toBeTruthy();
});
