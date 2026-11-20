// 서버 푸시 등록 여부는 계정마다 다시 판단한다(#560): A 계정에서 등록한 뒤 B 계정 등록이 실패하면
// 로컬 알림으로 돌아가야 한다(서버 푸시도 로컬 알림도 없는 상태가 되지 않게)
import { forgetPushRegistration, pushRegistered, registerPush } from '../lib/push';

const mockRegisterDevice = jest.fn();
jest.mock('../lib/api', () => ({
  api: { me: { registerDevice: (p: unknown) => mockRegisterDevice(p) } },
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-constants', () => ({ expoConfig: { extra: { eas: { projectId: 'p1' } } } }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: () => {},
  setNotificationChannelAsync: async () => {},
  requestPermissionsAsync: async () => ({ status: 'granted' }),
  getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[x]' }),
  AndroidImportance: { HIGH: 4 },
}));

beforeEach(() => {
  mockRegisterDevice.mockReset();
  forgetPushRegistration();
});

it('다른 계정으로 등록하다 실패하면 등록 안 됨으로 돌아간다', async () => {
  mockRegisterDevice.mockResolvedValueOnce(undefined);
  await registerPush();
  expect(pushRegistered()).toBe(true);
  mockRegisterDevice.mockRejectedValueOnce(new Error('network'));
  await expect(registerPush()).rejects.toThrow('network');
  expect(pushRegistered()).toBe(false);
});

it('로그아웃하면 등록 안 됨', async () => {
  mockRegisterDevice.mockResolvedValueOnce(undefined);
  await registerPush();
  forgetPushRegistration();
  expect(pushRegistered()).toBe(false);
});
