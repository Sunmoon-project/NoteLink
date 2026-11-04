import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { scanPages } from '../features/content/capture';
import { ConvertScreen } from '../features/content/convert';
import { useMockFlags } from '../lib/mock/flags';
import { socket } from '../lib/socket';
import { useDraft } from '../stores/draft';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0 },
  File: jest.fn().mockImplementation(() => ({ size: 10 })),
}));
jest.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: {},
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
  useAudioPlayer: jest.fn(),
  useAudioPlayerStatus: jest.fn(),
}));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: false })),
}));

const page = (n: string) => ({ uri: `file://${n}`, name: `${n}.jpg`, mimeType: 'image/jpeg' });

// PR #36 리뷰
describe('문서 스캔 + 추가', () => {
  it("'+ 추가'로 찍은 페이지는 기존 페이지 뒤에 붙는다", () => {
    expect(scanPages([page('A'), page('B')], [page('C')], true).map((p) => p.name)).toEqual([
      'A.jpg',
      'B.jpg',
      'C.jpg',
    ]);
  });
  it('다시 스캔은 새로 시작한다', () => {
    expect(scanPages([page('A')], [page('C')], false).map((p) => p.name)).toEqual(['C.jpg']);
  });
});

describe('AI 변환 다시 시도', () => {
  it('다시 시도로 새 작업이 생기면 그 작업을 구독한다', async () => {
    const emit = jest.spyOn(socket, 'emit');
    useMockFlags.setState({ llmFail: true });
    useDraft
      .getState()
      .set({ folderId: 'fo1', kind: 'handwriting', files: [page('A')], title: '테스트 노트' });
    await renderScreen(<ConvertScreen />);
    const subs = () =>
      emit.mock.calls
        .filter((c) => c[0] === 'ai:subscribe')
        .map((c) => (c[1] as { jobId: string }).jobId);
    await waitFor(() => expect(subs()).toHaveLength(1), { timeout: 5000 });
    await fireEvent.press(await screen.findByText('다시 시도', {}, { timeout: 15000 }));
    await waitFor(() => expect(subs()).toHaveLength(2), { timeout: 5000 });
    expect(subs()[1]).not.toBe(subs()[0]);
  }, 30000);
});
