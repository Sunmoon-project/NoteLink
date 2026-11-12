import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ScanCheckScreen, scanPages } from '../features/content/capture';
import { scanTitle } from '../lib/scan-title';
import { ConvertScreen, speechLocale } from '../features/content/convert';
import { seedUser } from './fixtures/seed';
import { useMockFlags } from './fixtures/flags';
import { socket } from '../lib/socket';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { AI_WAITING_STEP } from '../lib/ai';
import { useDraft } from '../stores/draft';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
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

const audio = { uri: 'file:///a.m4a', name: 'a.m4a', mimeType: 'audio/mp4', size: 1000 };

describe('서버 없이 저장한 자료', () => {
  it('자료 보기는 초안이 비워져도 처음 고른 종류의 상세로 간다', async () => {
    jest.spyOn(api.content, 'createMaterial').mockResolvedValue({
      material: { _id: 'm1' },
      job: { _id: 'j1', status: 'queued', step: AI_WAITING_STEP, progress: 0 },
    } as never);
    jest.spyOn(api.ai, 'job').mockResolvedValue({
      _id: 'j1',
      status: 'queued',
      step: AI_WAITING_STEP,
      progress: 0,
    } as never);
    useDraft.getState().set({ folderId: 'fo1', kind: 'recording', files: [audio], title: '강의' });
    await renderScreen(<ConvertScreen />);
    await fireEvent.press(await screen.findByText('자료 보기', {}, { timeout: 5000 }));
    // 폴더까지 돌아간 뒤 상세를 연다: 뒤로 가면 홈이 아니라 폴더가 나온다
    expect(router.dismissTo).toHaveBeenCalledWith({
      pathname: '/(tabs)/note/folder/[id]',
      params: { id: 'fo1' },
    });
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/note/rec/[id]',
      params: { id: 'm1' },
    });
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('받아쓰기 언어', () => {
  const register = () => {
    const spy = jest.spyOn(api.content, 'createMaterial').mockResolvedValue({
      material: { _id: 'm1' },
      job: { _id: 'j1', status: 'queued', step: AI_WAITING_STEP, progress: 0 },
    } as never);
    jest.spyOn(api.ai, 'job').mockResolvedValue({
      _id: 'j1',
      status: 'queued',
      step: AI_WAITING_STEP,
      progress: 0,
    } as never);
    return spy;
  };
  const me = (subtitleLanguage: string) =>
    jest.spyOn(api.me, 'get').mockResolvedValue({
      ...seedUser(),
      settings: { ...seedUser().settings, subtitleLanguage },
    });

  it('녹음은 설정한 받아쓰기 언어(English → en-US)로 등록한다', async () => {
    me('English');
    const spy = register();
    useDraft.getState().set({ folderId: 'fo1', kind: 'recording', files: [audio], title: '강의' });
    await renderScreen(<ConvertScreen />);
    // 앞 테스트 화면이 남긴 호출과 섞이지 않게, 이 녹음(제목 강의)의 등록을 찾는다
    await waitFor(() =>
      expect(spy.mock.calls.map(([p]) => p)).toContainEqual(
        expect.objectContaining({ kind: 'recording', title: '강의', language: 'en-US' }),
      ),
    );
  });

  it('녹음이 아니면 언어를 보내지 않는다', async () => {
    me('English');
    const spy = register();
    useDraft.getState().set({
      folderId: 'fo1',
      kind: 'document',
      files: [{ uri: 'file:///a.pdf', name: 'a.pdf', size: 10 }],
      title: '문서',
    });
    await renderScreen(<ConvertScreen />);
    await waitFor(() => expect(spy.mock.calls.some(([p]) => p.kind === 'document')).toBe(true));
    const doc = spy.mock.calls.find(([p]) => p.kind === 'document')![0];
    expect(doc).not.toHaveProperty('language');
  });
});

it('모르는 언어 설정은 한국어로 받아쓴다', () => {
  expect(speechLocale('日本語')).toBe('ja-JP');
  expect(speechLocale(undefined)).toBe('ko-KR');
  expect(speechLocale('Español')).toBe('ko-KR');
});

describe('스캔 제목', () => {
  const scan = { uri: 'file:///scan_1794403254407.jpg', name: 'scan_1794403254407.jpg', size: 100 };
  const created = () => {
    const spy = jest.spyOn(api.content, 'createMaterial').mockResolvedValue({
      material: { _id: 'm1' },
      job: { _id: 'j1', status: 'queued', step: AI_WAITING_STEP, progress: 0 },
    } as never);
    jest.spyOn(api.ai, 'job').mockResolvedValue({
      _id: 'j1',
      status: 'queued',
      step: AI_WAITING_STEP,
      progress: 0,
    } as never);
    return spy;
  };

  it('서울 날짜로 "11월 12일 스캔"을 만든다', () => {
    expect(scanTitle(Date.parse('2026-11-11T15:00:00Z'))).toBe('11월 12일 스캔');
  });

  it('제목을 정하지 않은 스캔은 기계식 파일 이름 대신 날짜 제목으로 올린다', async () => {
    const spy = created();
    useDraft.getState().reset();
    useDraft.getState().set({ folderId: 'fo1', kind: 'document', source: 'scan', files: [scan] });
    await renderScreen(<ConvertScreen />);
    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 });
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ title: scanTitle() });
  });

  it('스캔 확인에서 고친 제목으로 올린다', async () => {
    useDraft.getState().reset();
    useDraft.getState().set({ folderId: 'fo1', kind: 'document', source: 'scan', files: [scan] });
    await renderScreen(<ScanCheckScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText(scanTitle()), '광합성 프린트');
    expect(useDraft.getState().title).toBe('광합성 프린트');
    const spy = created();
    await renderScreen(<ConvertScreen />);
    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 });
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ title: '광합성 프린트' });
  });
});
