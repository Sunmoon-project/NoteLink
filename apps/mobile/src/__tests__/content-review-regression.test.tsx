import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { EditScreen, ShareScreen } from '../features/content/detail';
import { ConvertScreen } from '../features/content/convert';
import { useDraft } from '../stores/draft';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  content: {
    material: jest.fn(),
    updateSummary: jest.fn(async () => {}),
    folders: jest.fn(),
    materials: jest.fn(),
    createMaterial: jest.fn(),
    saveMaterial: jest.fn(async () => {}),
    share: jest.fn(async () => {}),
  },
  rooms: { mine: jest.fn() },
  social: { friends: jest.fn() },
  ai: { job: jest.fn(), retry: jest.fn(), cancel: jest.fn(async () => {}) },
};
const mockUpload = jest.fn();
const mockToast = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/upload', () => ({ uploadToBlob: (...args: unknown[]) => mockUpload(...args) }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: {},
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
  useAudioPlayer: jest.fn(),
  useAudioPlayerStatus: jest.fn(),
}));
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const job = (status = 'running') => ({
  _id: 'job1',
  status,
  targetId: 'mat1',
  progress: 50,
  attempts: 1,
  step: '정리',
});
const material = (_id: string, folderId: string, title: string) => ({
  _id,
  folderId,
  title,
  kind: 'handwriting',
  keywords: [],
  createdAt: '2026-10-29T00:00:00Z',
  summary: { sections: [{ heading: '기존 제목', body: '지우면 안 되는 본문' }] },
});
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
};
beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'mat1' });
  useDraft.getState().reset();
  useDraft.getState().set({
    folderId: 'folder2',
    files: [{ uri: 'file://a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' }],
    title: '노트',
  });
  useNet.setState({ state: 'ok' });
  mockUpload.mockResolvedValue('https://blob/a.jpg');
  mockApi.content.material.mockResolvedValue(material('mat1', 'folder2', '두 번째 폴더 노트'));
  mockApi.content.folders.mockResolvedValue([{ _id: 'folder1' }, { _id: 'folder2' }]);
  mockApi.content.materials.mockImplementation(async (fid: string) => [
    material('mat2', fid, fid === 'folder2' ? '두 번째 폴더 노트' : '첫 번째 폴더 노트'),
  ]);
  mockApi.rooms.mine.mockResolvedValue([{ _id: 'real-room', title: '실제 가입 방' }]);
  mockApi.social.friends.mockResolvedValue([]);
  mockApi.content.createMaterial.mockResolvedValue({
    material: material('mat1', 'folder2', '노트'),
    job: job(),
  });
  mockApi.ai.job.mockResolvedValue(job());
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.useRealTimers();
});

describe('PR36 편집 및 공유 회귀', () => {
  it('자료를 읽기 전에 저장해도 빈 본문을 전송하지 않는다', async () => {
    const pending = deferred<ReturnType<typeof material>>();
    mockApi.content.material.mockReturnValue(pending.promise);
    await renderScreen(<EditScreen />, client());
    for (const button of screen.queryAllByText('저장')) await fireEvent.press(button);
    expect(mockApi.content.updateSummary).not.toHaveBeenCalled();
    await act(async () => pending.resolve(material('mat1', 'folder2', '노트')));
    await waitFor(() =>
      expect(screen.getByLabelText('노트 내용').props.value).toContain('지우면 안 되는 본문'),
    );
    await fireEvent.press(screen.getAllByText('저장')[0]!);
    await waitFor(() =>
      expect(mockApi.content.updateSummary).toHaveBeenCalledWith('mat1', [
        { heading: '기존 제목', body: '지우면 안 되는 본문' },
      ]),
    );
  });
  it('공유 목록은 현재 폴더의 자료를 읽는다', async () => {
    setParams({ folderId: 'folder2' });
    await renderScreen(<ShareScreen />, client());
    expect(await screen.findByText('두 번째 폴더 노트')).toBeTruthy();
    expect(mockApi.content.materials).toHaveBeenCalledWith('folder2');
    expect(screen.queryByText('첫 번째 폴더 노트')).toBeNull();
  });
  it('조회된 실제 공유 대상을 선택하면 그 방과 현재 자료만 전송한다', async () => {
    setParams({ folderId: 'folder2', id: 'mat2' });
    await renderScreen(<ShareScreen />, client());
    await screen.findByText('두 번째 폴더 노트');
    await fireEvent.press(screen.getByText(/⌄/));
    await fireEvent.press(await screen.findByText('실제 가입 방'));
    await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
    await waitFor(() =>
      expect(mockApi.content.share).toHaveBeenCalledWith({
        materialIds: ['mat2'],
        target: { type: 'room', id: 'real-room' },
      }),
    );
  });
  it('가입한 공유 대상을 고르기 전에는 고정 room-1로 전송하지 않는다', async () => {
    setParams({ folderId: 'folder2', id: 'mat2' });
    await renderScreen(<ShareScreen />, client());
    await screen.findByText('두 번째 폴더 노트');
    await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
    await act(async () => {});
    expect(mockApi.content.share).not.toHaveBeenCalled();
    expect(screen.queryByText(/화학 스터디룸/)).toBeNull();
  });
});

describe('PR36 업로드 및 작업 복구 회귀', () => {
  it('자료 등록 전 실패하면 원본 저장 완료라고 안내하거나 화면을 닫지 않는다', async () => {
    mockApi.content.createMaterial.mockRejectedValue(new Error('등록 실패'));
    await renderScreen(<ConvertScreen />, client());
    await screen.findByText('정리에 실패했어요');
    const save = screen.queryByText('원본만 저장');
    if (save) await fireEvent.press(save);
    await act(async () => {});
    expect(mockApi.content.saveMaterial).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('원본만 저장했어요');
  });
  it('소켓 완료 이벤트를 놓쳐도 조회 성공으로 결과 화면에 한 번만 이동한다', async () => {
    jest.useFakeTimers();
    mockApi.ai.job.mockResolvedValue(job('succeeded'));
    await renderScreen(<ConvertScreen />, client());
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(1600);
    });
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/result/[id]',
      params: { id: 'mat1' },
    });
    await act(async () => {
      jest.advanceTimersByTime(3200);
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'canceled'])(
    '조회가 %s이면 생성 중 상태를 끝내고 복구 수단을 제공한다',
    async (status) => {
      jest.useFakeTimers();
      mockApi.ai.job.mockResolvedValue(job(status));
      await renderScreen(<ConvertScreen />, client());
      await act(async () => {});
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      expect(screen.getByText('정리에 실패했어요')).toBeTruthy();
      const calls = mockApi.ai.job.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(3200);
      });
      expect(mockApi.ai.job).toHaveBeenCalledTimes(calls);
    },
  );
  it('끊긴 업로드의 다시 시도를 연속으로 눌러도 업로드가 중복되지 않는다', async () => {
    const { NetworkError } = jest.requireMock('../lib/api') as { NetworkError: new () => Error };
    const pending = deferred<string>();
    mockUpload.mockRejectedValueOnce(new NetworkError()).mockReturnValue(pending.promise);
    await renderScreen(<ConvertScreen />, client());
    await screen.findByText('지금 다시 시도');
    const retry = screen.getByRole('button', { name: '지금 다시 시도' });
    const user = userEvent.setup();
    await user.press(retry);
    await user.press(retry);
    expect(mockUpload).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve('https://blob/a.jpg'));
    await waitFor(() => expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(1));
  });
});
