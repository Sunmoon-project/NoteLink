import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RecLiveScreen } from '../features/content/capture';
import { useDraft } from '../stores/draft';
import { renderScreen } from '../test-utils';

const mockPermission = jest.fn();
const mockAudioMode = jest.fn();
const mockToast = jest.fn();
const mockRecorder = {
  uri: 'file:///actual-live-recording.m4a' as string | null,
  prepareToRecordAsync: jest.fn(),
  record: jest.fn(),
  pause: jest.fn(),
  stop: jest.fn(),
};
const mockRecorderState = { durationMillis: 5200, isRecording: false, metering: -30 };
jest.mock('../lib/api', () => ({ api: {} }));
jest.mock('../lib/upload', () => ({ checkFile: jest.fn(), uploadToBlob: jest.fn() }));
jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: (...args: unknown[]) => mockPermission(...args),
  },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: (...args: unknown[]) => mockAudioMode(...args),
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => mockRecorderState,
}));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of [
    mockPermission,
    mockAudioMode,
    mockRecorder.prepareToRecordAsync,
    mockRecorder.record,
    mockRecorder.pause,
    mockRecorder.stop,
  ])
    fn.mockReset();
  mockPermission.mockResolvedValue({ granted: true });
  mockAudioMode.mockResolvedValue(undefined);
  mockRecorder.prepareToRecordAsync.mockResolvedValue(undefined);
  mockRecorder.stop.mockResolvedValue(undefined);
  mockRecorder.uri = 'file:///actual-live-recording.m4a';
  mockRecorderState.isRecording = false;
  mockRecorder.record.mockImplementation(() => {
    mockRecorderState.isRecording = true;
  });
  useDraft.getState().reset();
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

describe('PR36 실제 녹음 수명주기', () => {
  it('마이크 권한을 거절하면 녹음을 준비하거나 시작하지 않는다', async () => {
    mockPermission.mockResolvedValue({ granted: false });
    await renderScreen(<RecLiveScreen />, client());
    await screen.findByText('설정에서 허용하기');
    expect(mockRecorder.prepareToRecordAsync).not.toHaveBeenCalled();
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  it.each(['permission', 'prepare'] as const)(
    '%s 요청 오류는 처리하고 녹음이나 변환을 시작하지 않는다',
    async (stage) => {
      if (stage === 'permission') mockPermission.mockRejectedValue(new Error('권한 API 실패'));
      else mockRecorder.prepareToRecordAsync.mockRejectedValue(new Error('녹음 준비 실패'));
      await renderScreen(<RecLiveScreen />, client());
      await waitFor(() => expect(mockToast).toHaveBeenCalled());
      expect(mockRecorder.record).not.toHaveBeenCalled();
      expect(useDraft.getState().files).toEqual([]);
      expect(router.replace).not.toHaveBeenCalledWith('/convert');
    },
  );
  it('녹음 종료 실패를 안내하고 변환으로 이동하거나 초안을 저장하지 않는다', async () => {
    await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockRecorder.record).toHaveBeenCalledTimes(1));
    mockRecorder.stop.mockRejectedValueOnce(new Error('파일 마감 실패'));
    await expect(fireEvent.press(screen.getByText('변환 시작'))).resolves.toBeUndefined();
    expect(mockToast).toHaveBeenCalled();
    expect(useDraft.getState().files).toEqual([]);
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  it('준비 응답을 기다리다 화면을 나가면 뒤늦게 녹음을 시작하지 않는다', async () => {
    const pending = deferred<void>();
    mockRecorder.prepareToRecordAsync.mockReturnValue(pending.promise);
    const rendered = await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1));
    await rendered.unmount();
    await act(async () => pending.resolve());
    expect(mockRecorder.record).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  it('실제 녹음 파일이 있어야 녹음 초안을 저장하고 변환으로 이동한다', async () => {
    const rendered = await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockRecorder.record).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByText('변환 시작'));
    expect(useDraft.getState()).toMatchObject({
      kind: 'recording',
      source: 'live_recording',
      files: [
        expect.objectContaining({
          uri: 'file:///actual-live-recording.m4a',
          mimeType: 'audio/mp4',
        }),
      ],
    });
    expect(router.replace).toHaveBeenCalledWith('/convert');
    await rendered.unmount();
    await waitFor(() =>
      expect(mockAudioMode).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowsRecording: false }),
      ),
    );
  });
  it('녹음 종료 후 파일 주소가 없으면 빈 변환 작업을 시작하지 않는다', async () => {
    await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockRecorder.record).toHaveBeenCalledTimes(1));
    mockRecorder.uri = null;
    await fireEvent.press(screen.getByText('변환 시작'));
    expect(useDraft.getState().files).toEqual([]);
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
    expect(mockToast).toHaveBeenCalled();
  });
});
