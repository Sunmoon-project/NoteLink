import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import type { Material } from '@notelink/shared';
import { useToast } from '../stores/toast';
import { useRetrying } from '../stores/retrying';
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

afterEach(() => {
  jest.restoreAllMocks();
  useRetrying.getState().reset();
});

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
describe('다시 요약한 자료 따로 읽기', () => {
  it('목록이 계속 실패를 돌려줘도 그 자료는 따로 읽어 끝날 때까지 정리 중으로 보이고, 끝나면 결과를 보인다', async () => {
    const list = jest
      .spyOn(api.content, 'materials')
      .mockResolvedValue([material('doc', 'document', 'failed', 'job-doc')]);
    jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
    const one = jest
      .spyOn(api.content, 'material')
      .mockResolvedValueOnce(material('doc', 'document', 'processing', 'job-doc'))
      .mockResolvedValue(material('doc', 'document', 'done', 'job-doc'));
    setParams({ id: 'folder1' });
    await renderScreen(<FolderScreen />);
    await fireEvent.press(await screen.findByLabelText('doc 자료 다시 요약'));
    await waitFor(() => expect(one).toHaveBeenCalledWith('doc'));
    await waitFor(() => expect(screen.queryByLabelText('doc 자료 다시 요약')).toBeNull());
    // 3초 뒤 다시 읽어도 목록의 failed로 덮지 않고, 그 자료를 다시 읽어 끝났음을 보인다
    await waitFor(() => expect(one).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText(/요약 실패/)).toBeNull());
    expect(screen.queryByLabelText('doc 자료 다시 요약')).toBeNull();
    // 끝났으면 더 읽지 않는다
    const calls = list.mock.calls.length;
    await new Promise((r) => setTimeout(r, 3500));
    expect(list.mock.calls.length).toBe(calls);
  }, 15000);

  it('그 자료 읽기가 실패해도 정리 중으로 두고, 다시 읽어 또 실패했으면 다시 요약 버튼을 돌려준다', async () => {
    jest
      .spyOn(api.content, 'materials')
      .mockResolvedValue([material('doc', 'document', 'failed', 'job-doc')]);
    jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
    const one = jest
      .spyOn(api.content, 'material')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(material('doc', 'document', 'failed', 'job-doc'));
    setParams({ id: 'folder1' });
    await renderScreen(<FolderScreen />);
    await fireEvent.press(await screen.findByLabelText('doc 자료 다시 요약'));
    await waitFor(() => expect(one).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByLabelText('doc 자료 다시 요약')).toBeNull());
    await waitFor(() => expect(one).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(await screen.findByLabelText('doc 자료 다시 요약')).toBeTruthy();
  }, 15000);

  // Codex #520 5차 리뷰: 추적을 화면 안(useRef)에만 둬, 그 자료 읽기가 실패한 뒤 폴더를 닫았다 열면 추적이 사라졌다.
  // 실패한 자료가 많으면(21개 이상) 목록도 그 자료의 작업 상태를 맞추지 않아 실패로 보이고 다시 읽기가 멈췄다
  it('실패한 자료가 21개 이상이고 그 자료 읽기가 실패한 채 폴더를 닫았다 열어도, 다시 그 자료를 읽어 끝난 상태를 보인다', async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      material(`m${i}`, 'document', 'failed', `job-${i}`),
    );
    jest.spyOn(api.content, 'materials').mockResolvedValue(many);
    jest.spyOn(api.ai, 'retry').mockResolvedValue({} as never);
    const one = jest
      .spyOn(api.content, 'material')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(material('m20', 'document', 'done', 'job-20'));
    setParams({ id: 'folder1' });
    // 폴더 화면을 닫았다 다시 연다(같은 앱 · 같은 캐시)
    let show: (v: boolean) => void = () => {};
    function Remount() {
      const [on, set] = useState(true);
      show = set;
      return on ? <FolderScreen /> : null;
    }
    await renderScreen(<Remount />);
    await fireEvent.press(await screen.findByLabelText('m20 자료 다시 요약'));
    await waitFor(() => expect(one).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByLabelText('m20 자료 다시 요약')).toBeNull());
    await act(async () => show(false));
    await act(async () => show(true));
    await waitFor(() => expect(one).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText(/요약 실패/)).toHaveLength(20));
    expect(screen.queryByLabelText('m20 자료 다시 요약')).toBeNull();
    // 끝난 상태를 읽었으면 추적을 푼다
    expect(useRetrying.getState().byFolder.folder1 ?? []).toEqual([]);
  }, 15000);

  it('추적하던 자료가 목록에서 없어졌으면(지움) 추적을 푼다', async () => {
    useRetrying.setState({ byFolder: { folder1: ['gone'] } });
    jest
      .spyOn(api.content, 'materials')
      .mockResolvedValue([material('doc', 'document', 'done', 'job-doc')]);
    const one = jest.spyOn(api.content, 'material');
    setParams({ id: 'folder1' });
    await renderScreen(<FolderScreen />);
    await waitFor(() => expect(useRetrying.getState().byFolder.folder1 ?? []).toEqual([]));
    expect(one).not.toHaveBeenCalled();
  });
});
