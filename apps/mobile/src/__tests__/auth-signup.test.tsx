import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ERROR_CODES } from '@notelink/shared';
import { LoginScreen, ProfileSetupScreen, SignupScreen } from '../features/auth/auth';
import { confirmError, emailError, nicknameError, passwordError } from '../lib/validation';
import { api, ApiError } from '../lib/api';
import { useToast } from '../stores/toast';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

async function fill(email: string, pw: string, confirm = pw) {
  await renderScreen(<SignupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), email);
  await fireEvent.changeText(screen.getByPlaceholderText('영문 · 숫자 포함 8자 이상'), pw);
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), confirm);
}

/** 입력을 채우고 인증번호를 받아 인증번호 칸이 나올 때까지 */
async function toCode(email: string, pw: string) {
  await fill(email, pw);
  await fireEvent.press(screen.getByText('인증번호 받기'));
  return screen.findByPlaceholderText('메일로 받은 숫자 6자리');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('입력 검사', () => {
  it.each([
    ['', '이메일을 입력해 주세요'],
    ['a@', '이메일 형식을 확인해 주세요 (예: you@example.com)'],
    ['a@b.c', '이메일 형식을 확인해 주세요 (예: you@example.com)'],
    ['a..b@test.com', '이메일 형식을 확인해 주세요 (예: you@example.com)'],
    ['a b@test.com', '이메일 형식을 확인해 주세요 (예: you@example.com)'],
    [`${'a'.repeat(250)}@b.co`, '이메일이 너무 길어요'],
    [' a@b.co ', null],
    ['user@example.xn--p1ai', null],
  ])('이메일 %s', (v, expected) => expect(emailError(v)).toBe(expected));
  it.each([
    ['', '비밀번호를 입력해 주세요'],
    ['abc 12345', '비밀번호에는 공백을 넣을 수 없어요'],
    ['abc1234', '비밀번호는 8자 이상이어야 해요'],
    [`a1${'x'.repeat(63)}`, '비밀번호는 64자 이하로 정해 주세요'],
    ['12345678', '영문과 숫자를 모두 넣어 주세요'],
    ['abcdefgh', '영문과 숫자를 모두 넣어 주세요'],
    ['abcd1234', null],
  ])('비밀번호 %s', (v, expected) => expect(passwordError(v)).toBe(expected));
  it('비밀번호 확인', () => {
    expect(confirmError('abcd1234', '')).toBe('비밀번호를 한 번 더 입력해 주세요');
    expect(confirmError('abcd1234', 'abcd1235')).toBe('비밀번호가 서로 달라요');
    expect(confirmError('abcd1234', 'abcd1234')).toBeNull();
  });
  it.each([
    ['한', '닉네임은 2~10자로 정해 주세요'],
    ['열한글자넘는닉네임이야', '닉네임은 2~10자로 정해 주세요'],
    ['   ', '닉네임은 2~10자로 정해 주세요'],
    ['노트 러버', '닉네임은 한글 · 영문 · 숫자만 쓸 수 있어요'],
    ['노트!', '닉네임은 한글 · 영문 · 숫자만 쓸 수 있어요'],
    ['ㅋㅋㅋ', '닉네임은 한글 · 영문 · 숫자만 쓸 수 있어요'],
    [' 한결2 ', null],
    ['Note99', null],
  ])('닉네임 %s', (v, expected) => expect(nicknameError(v)).toBe(expected));
});

it('칸을 벗어나면 그 칸 아래에 안내하고, 쓰는 중에는 탓하지 않는다', async () => {
  await renderScreen(<SignupScreen />);
  const email = screen.getByPlaceholderText('you@example.com');
  await fireEvent.changeText(email, 'a@');
  expect(screen.queryByText(/이메일 형식을 확인해/)).toBeNull();
  await fireEvent(email, 'blur');
  expect(screen.getByText(/이메일 형식을 확인해/)).toBeTruthy();
  const pw = screen.getByPlaceholderText('영문 · 숫자 포함 8자 이상');
  await fireEvent.changeText(pw, '12345678');
  await fireEvent(pw, 'blur');
  expect(screen.getByText('영문과 숫자를 모두 넣어 주세요')).toBeTruthy();
});

it('빈 칸으로 인증번호 받기를 누르면 모든 칸의 안내를 한꺼번에 보여 주고 요청하지 않는다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode');
  await renderScreen(<SignupScreen />);
  await fireEvent.press(screen.getByText('인증번호 받기'));
  expect(screen.getByText('이메일을 입력해 주세요')).toBeTruthy();
  expect(screen.getByText('비밀번호를 입력해 주세요')).toBeTruthy();
  expect(screen.getByText('비밀번호를 한 번 더 입력해 주세요')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});

it('입력이 맞지 않으면 안내하고 인증번호를 보내지 않는다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode');
  await fill('new@test.com', 'abcd1234', 'abcd0000');
  expect(screen.getByText('비밀번호가 서로 달라요')).toBeTruthy();
  await fireEvent.press(screen.getByText('인증번호 받기'));
  expect(send).not.toHaveBeenCalled();
});

it('인증번호 받기 → 확인으로 받은 증표로 가입하고, 바로 로그인시키지 않고 이메일을 채운 로그인으로 보낸다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-1', expiresInSeconds: 600 });
  const signup = jest.spyOn(api.auth, 'emailSignup').mockResolvedValue(undefined);
  await fireEvent.changeText(await toCode(' new@test.com ', 'abcd1234'), '12a3456');
  expect(send).toHaveBeenCalledWith('new@test.com');
  // 숫자만 남긴다
  expect(screen.getByDisplayValue('123456')).toBeTruthy();
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(auth)/login',
      params: { email: 'new@test.com' },
    }),
  );
  expect(verify).toHaveBeenCalledWith('new@test.com', '123456');
  expect(signup).toHaveBeenCalledWith('proof-1', 'abcd1234');
  expect(useAuth.getState().tokens).toBeFalsy();
});

it('인증번호가 6자리가 아니면 확인하지 않고, 틀리면 칸 아래에 서버 안내를 보여 주고 가입하지 않는다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockRejectedValue(
      new ApiError(ERROR_CODES.EMAIL_CODE_INVALID, '인증번호가 맞지 않아요 (4번 남음)', 400),
    );
  const signup = jest.spyOn(api.auth, 'emailSignup');
  const input = await toCode('new@test.com', 'abcd1234');
  await fireEvent.changeText(input, '123');
  await fireEvent.press(screen.getByText('가입하기'));
  expect(screen.getByText('인증번호 6자리를 입력해 주세요')).toBeTruthy();
  expect(verify).not.toHaveBeenCalled();
  await fireEvent.changeText(input, '000000');
  await fireEvent.press(screen.getByText('가입하기'));
  expect(await screen.findByText('인증번호가 맞지 않아요 (4번 남음)')).toBeTruthy();
  expect(signup).not.toHaveBeenCalled();
});

it('인증번호 확인 횟수를 다 쓰면 알리고 인증번호 받기 단계로 돌아간다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockRejectedValue(
      new ApiError(ERROR_CODES.EMAIL_CODE_LOCKED, '인증번호를 새로 받아 주세요', 429),
    );
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '000000');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(useToast.getState().msg).toBe('인증번호를 새로 받아 주세요'));
  expect(screen.getByText('인증번호 받기')).toBeTruthy();
  expect(screen.queryByPlaceholderText('메일로 받은 숫자 6자리')).toBeNull();
});

it('인증번호를 보낸 뒤 이메일을 고치면 인증번호 받기 단계로 돌아간다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  await toCode('new@test.com', 'abcd1234');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'other@test.com');
  expect(screen.queryByPlaceholderText('메일로 받은 숫자 6자리')).toBeNull();
  expect(screen.getByText('인증번호 받기')).toBeTruthy();
});

it('인증번호를 너무 빨리 다시 받으면 서버 안내를 보여 준다', async () => {
  const send = jest
    .spyOn(api.auth, 'emailSendCode')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new ApiError(ERROR_CODES.RATE_LIMITED, '잠시 뒤 다시 받아 주세요', 429));
  await toCode('new@test.com', 'abcd1234');
  await fireEvent.press(screen.getByText('인증번호 다시 받기'));
  await waitFor(() => expect(useToast.getState().msg).toBe('잠시 뒤 다시 받아 주세요'));
  expect(send).toHaveBeenLastCalledWith('new@test.com');
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
  await fireEvent.changeText(await screen.findByPlaceholderText('you@example.com'), 'n@test.com');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'abcd1234');
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
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-old', expiresInSeconds: 600 });
  jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValue(new ApiError(ERROR_CODES.EMAIL_TAKEN, '이미 가입한 이메일이에요', 409));
  await fireEvent.changeText(await toCode('old@test.com', 'abcd1234'), '123456');
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
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-1', expiresInSeconds: 600 });
  jest.spyOn(api.auth, 'emailSignup').mockRejectedValue(new Error('네트워크'));
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
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

it('초기 설정은 닉네임 규칙과 빠진 학습자 유형을 칸 아래에 안내한다', async () => {
  const update = jest.spyOn(api.me, 'update');
  await renderScreen(<ProfileSetupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('노트러버'), '노트!');
  expect(screen.getByText('닉네임은 한글 · 영문 · 숫자만 쓸 수 있어요')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('노트러버'), '노트러버');
  await fireEvent.press(screen.getByText('시작하기'));
  expect(screen.getByText('학습자 유형을 골라 주세요')).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it('로그인은 가입 규칙과 별개로 기존 계정 주소(퓨니코드 최상위 도메인 등)를 막지 않는다', async () => {
  const user = await api.me.get();
  const login = jest
    .spyOn(api.auth, 'emailLogin')
    .mockResolvedValue({ accessToken: 'a', refreshToken: 'r', user });
  await renderScreen(<LoginScreen />);
  await fireEvent.changeText(
    await screen.findByPlaceholderText('you@example.com'),
    'user@example.xn--p1ai',
  );
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'oldpass1');
  await fireEvent.press(screen.getByText('로그인'));
  await waitFor(() => expect(login).toHaveBeenCalledWith('user@example.xn--p1ai', 'oldpass1'));
});
