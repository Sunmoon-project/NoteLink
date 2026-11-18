// 프로필 > 계정 정보: 학교 · 학년은 본인 인증 없이 고치고, 이메일 · 전화번호는 본인 인증 창을 연다
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { User } from '@notelink/shared';
import { AccountScreen, SchoolScreen } from '../features/profile/settings';
import { ApiError } from '../lib/api/http';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

const mockApi = {
  me: {
    get: jest.fn(),
    update: jest.fn(),
    interestCategories: jest.fn(async () => []),
    emailSendCode: jest.fn(async () => {}),
    emailVerifyCode: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  get ApiError() {
    return jest.requireActual('../lib/api/http').ApiError;
  },
}));
const user = (p: Partial<User> = {}) =>
  ({ _id: 'u1', nickname: '테스터', interestCategoryIds: [], email: 'me@a.co', ...p }) as User;

beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null });
});

it('학교 · 학년을 누르면 「본인 인증 후」 안내 대신 고치는 화면을 연다', async () => {
  mockApi.me.get.mockResolvedValue(user({ school: '선문고' }));
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('선문고'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/school');
  await fireEvent.press(screen.getByText('학년'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/grade');
  expect(useToast.getState().msg).toBeNull();
});

it('학교 화면은 앞뒤 공백을 지워 저장한다', async () => {
  mockApi.me.get.mockResolvedValue(user());
  mockApi.me.update.mockImplementation(async (p) => user(p));
  await renderScreen(<SchoolScreen />);
  await fireEvent.changeText(await screen.findByPlaceholderText('예: 선문고등학교'), ' 선문고 ');
  await fireEvent.press(screen.getByText('저장'));
  await waitFor(() => expect(mockApi.me.update).toHaveBeenCalledWith({ school: '선문고' }));
  expect(router.back).toHaveBeenCalled();
});

it('학교 화면은 저장된 값으로 시작하고, 고치기 전에는 저장하지 않는다(늦게 받아도 지우지 않게)', async () => {
  mockApi.me.get.mockResolvedValue(user({ school: '선문고' }));
  await renderScreen(<SchoolScreen />);
  expect(await screen.findByDisplayValue('선문고')).toBeTruthy();
  await fireEvent.press(screen.getByText('저장'));
  expect(mockApi.me.update).not.toHaveBeenCalled();
});

it('이메일을 누르면 인증 창이 뜨고, 인증번호를 확인하면 「인증됨」을 보인다', async () => {
  mockApi.me.get.mockResolvedValue(user());
  mockApi.me.emailVerifyCode.mockResolvedValue(user({ emailVerified: true }));
  await renderScreen(<AccountScreen />);
  await screen.findByText('학년');
  expect(await screen.findByText('인증 전')).toBeTruthy();
  await fireEvent.press(screen.getByText('me@a.co'));
  expect(await screen.findByText('이메일로 본인 인증')).toBeTruthy();
  await fireEvent.press(screen.getByText('인증번호 받기'));
  await waitFor(() => expect(mockApi.me.emailSendCode).toHaveBeenCalled());
  await fireEvent.changeText(
    await screen.findByPlaceholderText('메일로 받은 숫자 6자리'),
    '123456',
  );
  await fireEvent.press(screen.getByText('확인'));
  await waitFor(() => expect(mockApi.me.emailVerifyCode).toHaveBeenCalledWith('123456'));
  expect(await screen.findByText('인증됨')).toBeTruthy();
  expect(useToast.getState().msg).toBe('이메일 인증을 마쳤어요');
});

it('틀린 인증번호는 서버 안내를 창에 보이고 인증됨으로 바꾸지 않는다', async () => {
  mockApi.me.get.mockResolvedValue(user());
  mockApi.me.emailVerifyCode.mockRejectedValue(
    new ApiError('EMAIL_CODE_INVALID', '인증번호가 맞지 않아요', 400),
  );
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('me@a.co'));
  await fireEvent.press(await screen.findByText('인증번호 받기'));
  await fireEvent.changeText(
    await screen.findByPlaceholderText('메일로 받은 숫자 6자리'),
    '000000',
  );
  await fireEvent.press(screen.getByText('확인'));
  expect(await screen.findByText('인증번호가 맞지 않아요')).toBeTruthy();
  expect(screen.queryByText('인증됨')).toBeNull();
});

it('이메일이 없는 계정은 「이메일이 없어요」 안내만 보인다', async () => {
  mockApi.me.get.mockResolvedValue(user({ email: null }));
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('없음'));
  expect(await screen.findByText(/계정에 이메일이 없어요/)).toBeTruthy();
  expect(screen.queryByText('인증번호 받기')).toBeNull();
});

it('전화번호 창은 번호를 받지만 「문자 인증은 준비 중」으로 막고 인증됨으로 표시하지 않는다', async () => {
  mockApi.me.get.mockResolvedValue(user());
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('등록 안 함'));
  expect(await screen.findByText('전화번호로 본인 인증')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('01012345678'), '010-1234-5678');
  await fireEvent.press(screen.getByText('인증번호 받기'));
  expect(await screen.findByText('문자 인증은 준비 중이에요')).toBeTruthy();
  expect(screen.queryByText('인증됨')).toBeNull();
});
