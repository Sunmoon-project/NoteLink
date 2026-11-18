import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Material } from '@notelink/shared';
import { useToast } from '../stores/toast';
import { FolderScreen, materialsPollMs } from '../features/content/notes';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
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

// 실기기 테스트: 요약에 실패한 자료를 다시 요약할 방법이 자료마다 없었다
const material = (_id: string, kind: string, status: string, jobId: string | null) =>
  ({
    _id,
    folderId: 'folder1',
    title: `${_id} 자료`,
    kind,
    createdAt: '2026-11-18T00:00:00Z',
    processing: { status, progress: 0, jobId },
  }) as unknown as Material;

it('요약에 실패한 자료마다 「요약 실패」와 다시 요약 버튼이 있고, 누르면 그 자료의 작업을 다시 넣는다', async () => {
  useToast.setState({ msg: null });
  jest
    .spyOn(api.content, 'materials')
    .mockResolvedValue([
      material('doc', 'document', 'failed', 'job-doc'),
      material('rec', 'recording', 'failed', 'job-rec'),
      material('ok', 'handwriting', 'done', 'job-ok'),
    ]);
  const retry = jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />);
  expect(await screen.findByLabelText('doc 자료 다시 요약')).toBeTruthy();
  expect(screen.getByLabelText('rec 자료 다시 요약')).toBeTruthy();
  // 요약이 끝난 자료에는 없다
  expect(screen.queryByLabelText('ok 자료 다시 요약')).toBeNull();
  expect(screen.getAllByText(/요약 실패/)).toHaveLength(2);
  await fireEvent.press(screen.getByLabelText('doc 자료 다시 요약'));
  await waitFor(() => expect(retry).toHaveBeenCalledWith('job-doc'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('다시 요약하고 있어요. 끝나면 알려 드릴게요'),
  );
});

it('다시 요약 요청이 실패하면 알린다', async () => {
  useToast.setState({ msg: null });
  jest
    .spyOn(api.content, 'materials')
    .mockResolvedValue([material('doc', 'document', 'failed', 'job-doc')]);
  jest.spyOn(api.ai, 'retry').mockRejectedValue(new Error('offline'));
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />);
  await fireEvent.press(await screen.findByLabelText('doc 자료 다시 요약'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('다시 요약하지 못했어요. 잠시 뒤 다시 눌러 주세요'),
  );
});

// Codex #519 리뷰: 다시 요약 뒤 목록을 한 번만 읽어, 화면에 있으면 진행 표시가 계속 남고 버튼이 돌아오지 않았다
it('정리 중인 자료가 있으면 3초마다 목록을 다시 읽고, 모두 끝나면 멈춘다', () => {
  expect(
    materialsPollMs([
      material('a', 'document', 'processing', 'j1'),
      material('b', 'document', 'done', 'j2'),
    ]),
  ).toBe(3000);
  expect(materialsPollMs([material('a', 'document', 'queued', 'j1')])).toBe(3000);
  expect(
    materialsPollMs([
      material('a', 'document', 'failed', 'j1'),
      material('b', 'document', 'done', 'j2'),
    ]),
  ).toBe(false);
  expect(materialsPollMs(undefined)).toBe(false);
});

// Codex #520 리뷰: 목록은 한 번에 일부 자료만 작업 상태를 맞춰, 실패한 자료가 많으면 다시 넣은 자료가 계속 실패로 보였다
it('다시 요약한 자료는 그 자료만 다시 읽어 목록에 바로 정리 중으로 보인다', async () => {
  jest
    .spyOn(api.content, 'materials')
    .mockResolvedValue([material('doc', 'document', 'failed', 'job-doc')]);
  jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
  const one = jest
    .spyOn(api.content, 'material')
    .mockResolvedValue(material('doc', 'document', 'queued', 'job-doc'));
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />);
  await fireEvent.press(await screen.findByLabelText('doc 자료 다시 요약'));
  await waitFor(() => expect(one).toHaveBeenCalledWith('doc'));
  await waitFor(() => expect(screen.queryByLabelText('doc 자료 다시 요약')).toBeNull());
});

// Codex #520 재리뷰: 그 자료 읽기만 실패하면 계속 실패로 보이고 다시 읽기도 시작되지 않았다
it('다시 요약 뒤 그 자료 읽기가 실패해도 정리 중으로 보이고 목록을 다시 읽는다', async () => {
  const list = jest
    .spyOn(api.content, 'materials')
    .mockResolvedValue([material('doc', 'document', 'failed', 'job-doc')]);
  jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
  jest.spyOn(api.content, 'material').mockRejectedValue(new Error('network'));
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />);
  await fireEvent.press(await screen.findByLabelText('doc 자료 다시 요약'));
  await waitFor(() => expect(screen.queryByLabelText('doc 자료 다시 요약')).toBeNull());
  // 정리 중이라 3초 뒤 목록을 다시 읽는다
  const calls = list.mock.calls.length;
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls), { timeout: 5000 });
});
