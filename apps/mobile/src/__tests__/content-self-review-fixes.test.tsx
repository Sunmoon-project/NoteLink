import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { FolderScreen } from '../features/content/notes';
import { SharedScreen } from '../features/content/detail';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));

jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: {},
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
  useAudioPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    setPlaybackRate: jest.fn(),
  }),
  useAudioPlayerStatus: () => ({ currentTime: 42, duration: 180, playing: false, playbackRate: 1 }),
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

afterEach(() => jest.restoreAllMocks());

it('폴더는 확인을 거쳐야 삭제되고 취소하면 지우지 않는다', async () => {
  const remove = jest.spyOn(api.content, 'deleteFolder').mockResolvedValue(undefined);
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />);
  await fireEvent.press(await screen.findByLabelText('폴더 옵션'));
  await fireEvent.press(await screen.findByText('폴더 삭제'));
  expect(remove).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('취소'));
  expect(remove).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByLabelText('폴더 옵션'));
  await fireEvent.press(await screen.findByText('폴더 삭제'));
  await fireEvent.press(await screen.findByText('삭제'));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('folder1'));
});

it('공유 완료 화면에 고정된 공유 내역 수를 표시하지 않는다', async () => {
  setParams({ to: '실제 방', n: '2', tab: '필기', name: '실제 자료' });
  await renderScreen(<SharedScreen />);
  expect(await screen.findByText('실제 방에 필기 2개를 공유했어요')).toBeTruthy();
  expect(screen.queryByText('공유 내역 보기')).toBeNull();
});
