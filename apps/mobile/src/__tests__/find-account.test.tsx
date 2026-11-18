import { ERROR_CODES } from '@notelink/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
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

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('로그인 화면에서 아이디 · 비밀번호 찾기를 연다', async () => {
  await renderScreen(<LoginScreen />);
  await fireEvent.press(screen.getByText('아이디 · 비밀번호 찾기'));
  expect(router.push).toHaveBeenCalledWith('/(auth)/find-account');
});

it('아이디 찾기: 이메일로 인증번호를 받고 확인하면 가입한 아이디를 보여 준다', async () => {
  const send = jest.spyOn(api.auth, 'recoverySendCode');
  const find = jest.spyOn(api.auth, 'findId').mockResolvedValue({ id: 'note_user' });
  await renderScreen(<FindAccountScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  await waitFor(() => expect(send).toHaveBeenCalledWith('a@b.co'));
  await fireEvent.changeText(await screen.findByPlaceholderText('6자리 숫자'), '123456');
  await fireEvent.press(screen.getAllByText('아이디 찾기').at(-1)!);
  expect(await screen.findByText('가입한 아이디')).toBeTruthy();
  expect(screen.getByText('note_user')).toBeTruthy();
  expect(find).toHaveBeenCalledWith('a@b.co', '123456');
  await fireEvent.press(screen.getByText('이 아이디로 로그인'));
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/(auth)/login',
    params: { id: 'note_user' },
  });
});

it('아이디 찾기: 그 이메일로 가입한 계정이 없으면 알려 준다', async () => {
  jest.spyOn(api.auth, 'findId').mockResolvedValue({ id: null });
  await renderScreen(<FindAccountScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'x@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  await fireEvent.changeText(await screen.findByPlaceholderText('6자리 숫자'), '123456');
  await fireEvent.press(screen.getAllByText('아이디 찾기').at(-1)!);
  expect(await screen.findByText('이 이메일로 가입한 계정이 없어요')).toBeTruthy();
});

it('비밀번호 찾기: 아이디(4자 이상)와 이메일을 모두 넣어야 인증번호를 보낼 수 있다', async () => {
  await renderScreen(<FindAccountScreen />);
  await fireEvent.press(screen.getByText('비밀번호 찾기'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'c@d.co');
  await fireEvent.changeText(screen.getByPlaceholderText('아이디'), 'abc');
  expect(screen.getByRole('button', { name: '인증번호 보내기' })).toBeDisabled();
  // 아이디와 이메일은 서로 다른 값이다
  await fireEvent.changeText(screen.getByPlaceholderText('아이디'), 'note_user');
  expect(screen.getByRole('button', { name: '인증번호 보내기' })).toBeEnabled();
});

it('비밀번호 찾기: 그 이메일의 아이디가 아니면 알리고 인증번호를 다시 받게 한다', async () => {
  jest.spyOn(api.auth, 'recoverySendCode').mockResolvedValue(undefined);
  jest
    .spyOn(api.auth, 'passwordReset')
    .mockRejectedValue(
      new ApiError(ERROR_CODES.VALIDATION, '이 이메일로 가입한 아이디가 아니에요', 400),
    );
  await renderScreen(<FindAccountScreen />);
  await fireEvent.press(screen.getByText('비밀번호 찾기'));
  await fireEvent.changeText(screen.getByPlaceholderText('아이디'), 'wrong_id');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  await fireEvent.changeText(await screen.findByPlaceholderText('6자리 숫자'), '123456');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'newpass123');
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), 'newpass123');
  await fireEvent.press(screen.getByText('비밀번호 바꾸기'));
  // 그 인증번호는 이미 쓴 것이라 인증번호 칸을 닫고 다시 보내게 한다
  await waitFor(() => expect(screen.queryByPlaceholderText('6자리 숫자')).toBeNull());
  expect(screen.getByText('인증번호 보내기')).toBeTruthy();
});

it('비밀번호 찾기: 아이디 · 이메일 · 인증번호를 확인하고 새 비밀번호로 바꾼 뒤 로그인으로', async () => {
  const reset = jest.spyOn(api.auth, 'passwordReset').mockResolvedValue(undefined);
  await renderScreen(<FindAccountScreen />);
  await fireEvent.press(screen.getByText('비밀번호 찾기'));
  await fireEvent.changeText(screen.getByPlaceholderText('아이디'), 'Note_User');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'A@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  await fireEvent.changeText(await screen.findByPlaceholderText('6자리 숫자'), '123456');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'newpass123');
  await fireEvent.changeText(screen.getByPlaceholderText('한 번 더 입력해 주세요'), 'newpass123');
  await fireEvent.press(screen.getByText('비밀번호 바꾸기'));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/(auth)/login',
      params: { id: 'note_user' },
    }),
  );
  expect(reset).toHaveBeenCalledWith('Note_User', 'A@b.co', '123456', 'newpass123');
});

it('서버에 아직 경로가 없으면(404) 준비 중이라고 안내한다', async () => {
  jest
    .spyOn(api.auth, 'recoverySendCode')
    .mockRejectedValue(new ApiError('NOT_FOUND', 'Cannot POST', 404));
  await renderScreen(<FindAccountScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  expect(await screen.findByText(/아직 준비 중이에요/)).toBeTruthy();
});

it('인증번호를 보내는 중에는 이메일을 바꿀 수 없고, 다른 이메일로 바꾸면 인증번호 칸을 닫는다', async () => {
  let done!: () => void;
  jest
    .spyOn(api.auth, 'recoverySendCode')
    .mockImplementationOnce(() => new Promise<void>((r) => (done = r)))
    .mockResolvedValue(undefined);
  await renderScreen(<FindAccountScreen />);
  await fireEvent.press(screen.getByText('비밀번호 찾기'));
  await fireEvent.changeText(screen.getByPlaceholderText('아이디'), 'note_user');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.co');
  await fireEvent.press(screen.getByText('인증번호 보내기'));
  // 보내는 중에는 두 칸을 잠근다
  await waitFor(() =>
    expect(screen.getByPlaceholderText('you@example.com').props.editable).toBe(false),
  );
  expect(screen.getByPlaceholderText('아이디').props.editable).toBe(false);
  await act(async () => done());
  expect(await screen.findByPlaceholderText('6자리 숫자')).toBeTruthy();
  // 보낸 뒤 이메일을 바꾸면 그 이메일로는 보내지 않았으니 인증번호 칸을 닫는다
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'a@b.cox');
  expect(screen.queryByPlaceholderText('6자리 숫자')).toBeNull();
});
