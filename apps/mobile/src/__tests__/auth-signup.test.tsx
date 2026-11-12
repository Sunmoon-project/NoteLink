import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ERROR_CODES } from '@notelink/shared';
import {
  LoginScreen,
  ProfileSetupScreen,
  SignupCodeScreen,
  SignupScreen,
  useSignup,
} from '../features/auth/auth';
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

/** 입력을 채우고 인증번호를 받아 인증번호 화면으로 넘어가 그 칸이 나올 때까지 */
async function toCode(email: string, pw: string) {
  await fill(email, pw);
  await fireEvent.press(screen.getByText('인증번호 받기'));
  const to = email.trim();
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(auth)/signup-code',
      params: { email: to },
    }),
  );
  // 다시 받기 대기(60초)는 따로 확인한다 — 여기서는 바로 다시 받을 수 있게
  useSignup.setState({ sentAt: 0 });
  setParams({ email: to });
  await renderScreen(<SignupCodeScreen />);
  return screen.findByPlaceholderText('메일로 받은 숫자 6자리');
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  useSignup.getState().reset();
  setParams({});
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

it('인증번호 확인 횟수를 다 쓰면 알리고, 칸을 비워 바로 새로 받을 수 있게 한다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockRejectedValue(
      new ApiError(ERROR_CODES.EMAIL_CODE_LOCKED, '인증번호를 새로 받아 주세요', 429),
    );
  const input = await toCode('new@test.com', 'abcd1234');
  useSignup.setState({ sentAt: Date.now() }); // 방금 보낸 상태여도
  await fireEvent.changeText(input, '000000');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(useToast.getState().msg).toBe('인증번호를 새로 받아 주세요'));
  expect(screen.getByText('인증번호를 새로 받아 주세요 인증번호를 다시 받아 주세요')).toBeTruthy();
  expect(screen.queryByDisplayValue('000000')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '인증번호 다시 받기' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
});

it('보낸 지 60초가 지나기 전에는 다시 받기를 막고 남은 시간을 보여 준다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  await toCode('new@test.com', 'abcd1234');
  useSignup.setState({ sentAt: Date.now() });
  const resend = await screen.findByRole('button', { name: '인증번호 다시 받기' });
  expect(resend).toBeDisabled();
  expect(screen.getByText(/다시 받기 \(\d+초\)/)).toBeTruthy();
});

it('인증번호 화면에서 이메일 바꾸기를 누르면 앞 화면으로, 거기서 이메일을 고치면 보낸 인증번호를 버린다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  await toCode('new@test.com', 'abcd1234');
  expect(screen.getByText('new@test.com로 보낸 인증번호 6자리를 입력해 주세요')).toBeTruthy();
  await fireEvent.press(screen.getByText('이메일 바꾸기'));
  expect(router.back).toHaveBeenCalled();
  await renderScreen(<SignupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'other@test.com');
  expect(useSignup.getState().sentTo).toBeNull();
});

it('가입 정보 없이 인증번호 화면을 열면(앱을 다시 켬) 처음부터 하게 한다', async () => {
  setParams({ email: 'new@test.com' });
  await renderScreen(<SignupCodeScreen />);
  expect(
    screen.getByText('가입 정보가 없어요. 이메일과 비밀번호를 다시 입력해 주세요.'),
  ).toBeTruthy();
  await fireEvent.press(screen.getByText('처음부터 하기'));
  expect(router.replace).toHaveBeenCalledWith('/(auth)/signup');
});

it('보내는 사이 이메일을 고치면 늦게 온 옛 주소의 발송 응답을 버린다', async () => {
  let done!: () => void;
  jest
    .spyOn(api.auth, 'emailSendCode')
    .mockImplementationOnce(() => new Promise<void>((r) => (done = r)));
  useToast.setState({ msg: null });
  await fill('a@test.com', 'abcd1234');
  await fireEvent.press(screen.getByText('인증번호 받기'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'b@test.com');
  done();
  await waitFor(() => expect(screen.getByText('인증번호 받기')).toBeTruthy());
  await new Promise((r) => setTimeout(r, 20));
  expect(router.push).not.toHaveBeenCalled();
  expect(useToast.getState().msg).not.toBe('인증번호를 보냈어요. 메일을 확인해 주세요');
});

it('인증은 됐는데 가입 요청만 실패하면 다시 누를 때 받아 둔 증표로 가입만 다시 한다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-1', expiresInSeconds: 600 });
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('가입하지 못했어요. 다시 시도해 주세요'),
  );
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
  expect(verify).toHaveBeenCalledTimes(1);
  expect(signup).toHaveBeenNthCalledWith(2, 'proof-1', 'abcd1234');
});

it('가입 요청만 실패한 뒤 인증번호를 다시 받으면, 받아 둔 증표를 버리고 새 번호로 확인해 가입한다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValueOnce({ verificationToken: 'proof-1', expiresInSeconds: 600 })
    .mockResolvedValueOnce({ verificationToken: 'proof-2', expiresInSeconds: 600 });
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  const input = await toCode('new@test.com', 'abcd1234');
  await fireEvent.changeText(input, '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByText('인증번호 다시 받기'));
  await waitFor(() => expect(api.auth.emailSendCode).toHaveBeenCalledTimes(2));
  await fireEvent.changeText(screen.getByPlaceholderText('메일로 받은 숫자 6자리'), '654321');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
  expect(verify).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenLastCalledWith('new@test.com', '654321');
  expect(signup).toHaveBeenLastCalledWith('proof-2', 'abcd1234');
});

it('인증번호를 다시 받다 메일 발송이 실패해도, 서버가 무효로 한 옛 증표는 버리고 새로 확인한다', async () => {
  jest
    .spyOn(api.auth, 'emailSendCode')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('smtp'));
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-2', expiresInSeconds: 600 });
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByText('인증번호 다시 받기'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('인증번호를 보내지 못했어요. 다시 시도해 주세요'),
  );
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
  expect(verify).toHaveBeenCalledTimes(2);
});

it('인증번호를 다시 받는 중에는 가입을, 가입하는 중에는 다시 받기를 보내지 않는다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode').mockResolvedValueOnce(undefined);
  let sent!: () => void;
  send.mockImplementationOnce(() => new Promise<void>((r) => (sent = r)));
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-1', expiresInSeconds: 600 });
  let signed!: () => void;
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockImplementation(() => new Promise<void>((r) => (signed = r)));
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
  // 다시 받기 응답을 기다리는 동안 가입을 누른다
  const resend = () => screen.getByRole('button', { name: '인증번호 다시 받기' });
  await fireEvent.press(resend());
  await waitFor(() => expect(resend()).toBeDisabled());
  await fireEvent.press(screen.getByText('가입하기'));
  expect(api.auth.emailVerifyCode).not.toHaveBeenCalled();
  sent();
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('인증번호를 보냈어요. 메일을 확인해 주세요'),
  );
  // 새 번호로 가입 응답을 기다리는 동안 다시 받기를 누른다
  await fireEvent.changeText(screen.getByPlaceholderText('메일로 받은 숫자 6자리'), '654321');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
  expect(resend()).toBeDisabled();
  await fireEvent.press(resend());
  expect(send).toHaveBeenCalledTimes(2);
  signed();
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
});

it('인증번호를 확인하는 사이 가입 정보가 바뀌면(앞 화면에서 이메일을 고침) 옛 주소로 가입하지 않는다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  let done!: (v: { verificationToken: string; expiresInSeconds: number }) => void;
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockImplementationOnce(() => new Promise((r) => (done = r)));
  const signup = jest.spyOn(api.auth, 'emailSignup').mockResolvedValue(undefined);
  await fireEvent.changeText(await toCode('a@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  useSignup.getState().reset();
  done({ verificationToken: 'proof-a', expiresInSeconds: 600 });
  await new Promise((r) => setTimeout(r, 20));
  expect(signup).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it.each([ERROR_CODES.EMAIL_TAKEN, ERROR_CODES.EMAIL_PROOF_INVALID])(
  '이메일을 바꿔 새 번호를 받은 뒤 옛 주소의 가입이 늦게 %s 로 실패해도 지금 단계를 건드리지 않는다',
  async (code) => {
    jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
    jest
      .spyOn(api.auth, 'emailVerifyCode')
      .mockResolvedValue({ verificationToken: 'proof-a', expiresInSeconds: 600 });
    let fail!: (e: unknown) => void;
    jest
      .spyOn(api.auth, 'emailSignup')
      .mockImplementationOnce(() => new Promise((_, no) => (fail = no)));
    await fireEvent.changeText(await toCode('a@test.com', 'abcd1234'), '123456');
    await fireEvent.press(screen.getByText('가입하기'));
    await waitFor(() => expect(api.auth.emailSignup).toHaveBeenCalled());
    // 앞 화면에서 b로 바꿔 새 번호를 받았다
    useSignup.getState().next();
    const sentAt = Date.now();
    useSignup.setState({
      sentTo: 'b@test.com',
      sentAt,
      proof: { email: 'b@test.com', token: 'proof-b' },
    });
    useToast.setState({ msg: null });
    fail(new ApiError(code, '옛 주소 실패', 409));
    await new Promise((r) => setTimeout(r, 20));
    expect(useSignup.getState()).toMatchObject({
      sentTo: 'b@test.com',
      sentAt,
      proof: { email: 'b@test.com', token: 'proof-b' },
    });
    expect(useToast.getState().msg).toBeNull();
    expect(screen.queryByText('이미 가입한 이메일이에요')).toBeNull();
  },
);

/** 앞 화면으로 돌아가 b로 새 번호를 받은 것처럼 (보내기 → 새 흐름) */
const switchToB = (proof: { email: string; token: string } | null = null) => {
  useSignup.getState().next();
  useSignup.setState({ email: 'b@test.com', sentTo: 'b@test.com', sentAt: 123, proof });
};

it('옛 주소의 인증 응답이 늦게 와도 새 흐름의 증표를 덮어쓰지 않고 가입하지 않는다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  let done!: (v: { verificationToken: string; expiresInSeconds: number }) => void;
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockImplementationOnce(() => new Promise((r) => (done = r)));
  const signup = jest.spyOn(api.auth, 'emailSignup').mockResolvedValue(undefined);
  await fireEvent.changeText(await toCode('a@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  switchToB({ email: 'b@test.com', token: 'proof-b' });
  done({ verificationToken: 'proof-a', expiresInSeconds: 600 });
  await new Promise((r) => setTimeout(r, 20));
  expect(useSignup.getState().proof).toEqual({ email: 'b@test.com', token: 'proof-b' });
  expect(signup).not.toHaveBeenCalled();
});

it('옛 주소의 가입이 늦게 성공해도 새 가입 정보를 지우거나 화면을 떠나지 않는다', async () => {
  jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-a', expiresInSeconds: 600 });
  let ok!: () => void;
  jest
    .spyOn(api.auth, 'emailSignup')
    .mockImplementationOnce(() => new Promise<void>((r) => (ok = r)));
  await fireEvent.changeText(await toCode('a@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(api.auth.emailSignup).toHaveBeenCalled());
  switchToB();
  useToast.setState({ msg: null });
  ok();
  await new Promise((r) => setTimeout(r, 20));
  expect(useSignup.getState()).toMatchObject({ sentTo: 'b@test.com', email: 'b@test.com' });
  expect(router.replace).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toBeNull();
});

it('발송을 기다리다 화면을 나가 다른 이메일로 새로 가입 중이면, 옛 발송 응답이 새 정보를 덮어쓰지 않는다', async () => {
  let sentA!: () => void;
  jest
    .spyOn(api.auth, 'emailSendCode')
    .mockImplementationOnce(() => new Promise<void>((r) => (sentA = r)))
    .mockResolvedValueOnce(undefined);
  await fill('a@test.com', 'abcd1234');
  await fireEvent.press(screen.getByText('인증번호 받기'));
  // 다시 들어온 새 가입 화면에서 b로 보내고 인증 화면까지 갔다(옛 화면의 발송은 아직 대기 중)
  await toCode('b@test.com', 'bbbb1234');
  useSignup.setState({ proof: { email: 'b@test.com', token: 'proof-b' } });
  const before = useSignup.getState();
  jest.mocked(router.push).mockClear();
  useToast.setState({ msg: null });
  sentA();
  await new Promise((r) => setTimeout(r, 20));
  expect(useSignup.getState()).toMatchObject({
    email: 'b@test.com',
    pw: 'bbbb1234',
    sentTo: 'b@test.com',
    sentAt: before.sentAt,
    proof: { email: 'b@test.com', token: 'proof-b' },
  });
  expect(router.push).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toBeNull();
});

it.each(['성공', '실패'] as const)(
  '다시 받는 사이 같은 이메일로 새 흐름이 시작되면 옛 다시 받기 %s 응답은 새 흐름을 건드리지 않는다',
  async (result) => {
    const send = jest.spyOn(api.auth, 'emailSendCode').mockResolvedValueOnce(undefined);
    let settle!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise<void>((ok, no) => {
          settle = result === '성공' ? ok : () => no(new Error('smtp'));
        }),
    );
    await toCode('a@test.com', 'abcd1234');
    await fireEvent.press(screen.getByRole('button', { name: '인증번호 다시 받기' }));
    // 앞 화면에서 같은 a로 다시 보내 새 흐름이 됐다 — 이메일만 보면 구분되지 않는다
    useSignup.getState().next();
    useSignup.setState({ sentAt: 123 });
    useToast.setState({ msg: null });
    settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(useSignup.getState()).toMatchObject({ sentTo: 'a@test.com', sentAt: 123 });
    expect(useToast.getState().msg).toBeNull();
  },
);

it('보내는 사이 비밀번호를 고쳐도 누를 때 검사한 비밀번호로 가입한다', async () => {
  let sent!: () => void;
  jest
    .spyOn(api.auth, 'emailSendCode')
    .mockImplementationOnce(() => new Promise<void>((r) => (sent = r)));
  await fill('new@test.com', 'abcd1234');
  await fireEvent.press(screen.getByText('인증번호 받기'));
  await fireEvent.changeText(screen.getByPlaceholderText('영문 · 숫자 포함 8자 이상'), '');
  sent();
  await waitFor(() => expect(router.push).toHaveBeenCalled());
  expect(useSignup.getState().pw).toBe('abcd1234');
});

it('다시 받는 사이 다른 이메일로 바꾸면 옛 주소의 발송 응답이 새 주소의 대기를 건드리지 않는다', async () => {
  const send = jest.spyOn(api.auth, 'emailSendCode').mockResolvedValueOnce(undefined);
  let sent!: () => void;
  send.mockImplementationOnce(() => new Promise<void>((r) => (sent = r)));
  await toCode('a@test.com', 'abcd1234');
  await fireEvent.press(screen.getByRole('button', { name: '인증번호 다시 받기' }));
  useSignup.setState({ sentTo: 'b@test.com', sentAt: 123 });
  useToast.setState({ msg: null });
  sent();
  await new Promise((r) => setTimeout(r, 20));
  expect(useSignup.getState().sentAt).toBe(123);
  expect(useToast.getState().msg).toBeNull();
});

it.each([ERROR_CODES.EMAIL_PROOF_EXPIRED, ERROR_CODES.EMAIL_PROOF_INVALID])(
  '증표가 %s 이면 알리고, 인증번호를 다시 받아 새로 인증한다',
  async (code) => {
    jest.spyOn(api.auth, 'emailSendCode').mockResolvedValue(undefined);
    const verify = jest
      .spyOn(api.auth, 'emailVerifyCode')
      .mockResolvedValueOnce({ verificationToken: 'proof-1', expiresInSeconds: 600 })
      .mockResolvedValueOnce({ verificationToken: 'proof-2', expiresInSeconds: 600 });
    const signup = jest
      .spyOn(api.auth, 'emailSignup')
      .mockRejectedValueOnce(new ApiError(code, '인증을 다시 해 주세요', 400))
      .mockResolvedValueOnce(undefined);
    await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
    await fireEvent.press(screen.getByText('가입하기'));
    await waitFor(() => expect(useToast.getState().msg).toBe('인증을 다시 해 주세요'));
    await fireEvent.press(screen.getByRole('button', { name: '인증번호 다시 받기' }));
    await waitFor(() => expect(api.auth.emailSendCode).toHaveBeenCalledTimes(2));
    await fireEvent.changeText(screen.getByPlaceholderText('메일로 받은 숫자 6자리'), '654321');
    await fireEvent.press(screen.getByText('가입하기'));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(verify).toHaveBeenLastCalledWith('new@test.com', '654321');
    expect(signup).toHaveBeenLastCalledWith('proof-2', 'abcd1234');
  },
);

it('가입만 실패한 뒤 다시 받기가 발송 제한에 걸리면, 서버가 번호를 새로 내지 않았으니 받아 둔 증표로 가입만 다시 한다', async () => {
  jest
    .spyOn(api.auth, 'emailSendCode')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new ApiError(ERROR_CODES.RATE_LIMITED, '잠시 뒤 다시 받아 주세요', 429));
  const verify = jest
    .spyOn(api.auth, 'emailVerifyCode')
    .mockResolvedValue({ verificationToken: 'proof-1', expiresInSeconds: 600 });
  const signup = jest
    .spyOn(api.auth, 'emailSignup')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  await fireEvent.changeText(await toCode('new@test.com', 'abcd1234'), '123456');
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
  await fireEvent.press(screen.getByRole('button', { name: '인증번호 다시 받기' }));
  await waitFor(() => expect(useToast.getState().msg).toBe('잠시 뒤 다시 받아 주세요'));
  await fireEvent.press(screen.getByText('가입하기'));
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
  expect(verify).toHaveBeenCalledTimes(1);
  expect(signup).toHaveBeenLastCalledWith('proof-1', 'abcd1234');
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

it('관심 분야를 선택하면 이름 대신 서버 카테고리 ID를 전송한다', async () => {
  jest
    .spyOn(api.me, 'interestCategories')
    .mockResolvedValue([{ _id: '507f1f77bcf86cd799439011', name: '수능', parentId: null }]);
  const update = jest.spyOn(api.me, 'update');
  await renderScreen(<ProfileSetupScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('노트러버'), '한결');
  await fireEvent.press(screen.getByText('대학생'));
  await fireEvent.press(await screen.findByText('수능'));
  await fireEvent.press(screen.getByText('시작하기'));
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ interestCategoryIds: ['507f1f77bcf86cd799439011'] }),
    ),
  );
});

it('이미 있는 이메일이면 로그인으로 돌아갈 길을 보여 준다', async () => {
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
  expect(screen.getByDisplayValue('123456')).toBeTruthy();
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
