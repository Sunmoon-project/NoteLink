import * as SecureStore from 'expo-secure-store';
import { useDevicePrefs } from '../stores/device-prefs';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => {}),
}));
const read = jest.mocked(SecureStore.getItemAsync);

beforeEach(() => {
  jest.clearAllMocks();
  useDevicePrefs.setState({ deskMode: true, loaded: false });
});

it('앱을 다시 켜면 저장한 탁상 모드 꺼짐을 되살린다', async () => {
  read.mockResolvedValue(JSON.stringify({ deskMode: false }));
  await useDevicePrefs.getState().load();
  expect(useDevicePrefs.getState()).toMatchObject({ deskMode: false, loaded: true });
});

it.each([
  ['저장한 적 없음', async () => null],
  ['깨진 값', async () => '{not json'],
  ['모양이 다른 값', async () => JSON.stringify({ deskMode: 'no' })],
  [
    '읽기 실패',
    async () => {
      throw new Error('keychain');
    },
  ],
])('%s이면 기본값(켜짐)으로 읽기를 마친다', async (_, impl) => {
  read.mockImplementation(impl as never);
  await useDevicePrefs.getState().load();
  expect(useDevicePrefs.getState()).toMatchObject({ deskMode: true, loaded: true });
});

it('읽는 사이 스위치를 바꾸면 늦게 온 저장값으로 덮지 않는다', async () => {
  let done: (v: string) => void = () => {};
  read.mockReturnValue(new Promise<string>((r) => (done = r)));
  const loading = useDevicePrefs.getState().load();
  useDevicePrefs.getState().set({ deskMode: false });
  done(JSON.stringify({ deskMode: true }));
  await loading;
  expect(useDevicePrefs.getState().deskMode).toBe(false);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    'notelink.device-prefs',
    JSON.stringify({ deskMode: false }),
  );
});
