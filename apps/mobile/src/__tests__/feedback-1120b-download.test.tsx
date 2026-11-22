import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import { DocDetailScreen, summaryMarkdown } from '../features/content/detail';
import { renderScreen, setParams } from '../test-utils';
import { useToast } from '../stores/toast';

// 실기기 피드백(2026-11-20): 문서 상세 「다운로드」가 정리본이 아닌 원본만 받았다
const mockWritten: Record<string, string> = {};
jest.mock('expo-file-system', () => {
  class Directory {
    exists = true;
    create() {}
  }
  class File {
    uri: string;
    exists = false;
    constructor(_dir: unknown, name: string) {
      this.uri = `file:///docs/downloads/${name}`;
    }
    create() {}
    delete() {}
    write(text: string) {
      mockWritten[this.uri] = text;
    }
    static downloadFileAsync = jest.fn(async () => ({ uri: 'file:///docs/downloads/원본.pdf' }));
  }
  return { Directory, File, Paths: { document: {} } };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));
const mockApi = {
  content: { material: jest.fn(), folders: jest.fn(), downloadUrl: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'https://api.example' } }));

const doc = {
  _id: 'm1',
  folderId: 'f1',
  kind: 'document',
  title: '운영체제 3장',
  createdAt: '2026-11-01T00:00:00Z',
  processing: { status: 'done', progress: 100, jobId: null },
  summary: {
    points: ['프로세스는 실행 중인 프로그램'],
    sections: [{ heading: '스케줄링', body: 'FCFS와 SJF' }],
  },
  keywords: ['프로세스', '스레드'],
  bookmarks: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'm1' });
  mockApi.content.material.mockResolvedValue(doc);
  mockApi.content.folders.mockResolvedValue([]);
  mockApi.content.downloadUrl.mockResolvedValue({
    url: 'https://blob.example/원본.pdf',
    fileName: '원본.pdf',
  });
});

it('정리본은 제목 · 핵심 요약 · 정리된 내용 · 키워드 순서의 마크다운', () => {
  expect(summaryMarkdown(doc)).toBe(
    '# 운영체제 3장\n\n## 핵심 요약\n\n- 프로세스는 실행 중인 프로그램\n\n## 스케줄링\n\nFCFS와 SJF\n\n## 키워드\n\n프로세스 · 스레드\n',
  );
});

it('다운로드를 누르면 정리본 · 원본을 고르고, 정리본은 원본 주소 없이 .md 로 저장한다', async () => {
  await renderScreen(<DocDetailScreen />);
  await fireEvent.press(await screen.findByText('다운로드'));
  await fireEvent.press(screen.getByText('정리본 (.md)'));
  await waitFor(() =>
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///docs/downloads/운영체제 3장.md'),
  );
  expect(mockWritten['file:///docs/downloads/운영체제 3장.md']).toBe(summaryMarkdown(doc));
  expect(mockApi.content.downloadUrl).not.toHaveBeenCalled();
});

it('원본 파일을 고르면 전처럼 원본을 받는다', async () => {
  await renderScreen(<DocDetailScreen />);
  await fireEvent.press(await screen.findByText('다운로드'));
  await fireEvent.press(screen.getByText('원본 파일'));
  await waitFor(() => expect(mockApi.content.downloadUrl).toHaveBeenCalledWith('m1'));
});

it('정리가 아직 없으면 원본만 고를 수 있다', async () => {
  mockApi.content.material.mockResolvedValue({ ...doc, summary: null });
  await renderScreen(<DocDetailScreen />);
  await fireEvent.press(await screen.findByText('다운로드'));
  expect(screen.getByText('원본 파일')).toBeTruthy();
  expect(screen.queryByText('정리본 (.md)')).toBeNull();
});

// #585 독립 검증: 정리본 저장은 기기 파일 일이라 실패해도 「연결을 확인해 주세요」가 맞지 않았다
it('정리본 저장이 실패하면 연결이 아닌 파일 저장 실패로 알린다', async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('disk'));
  await renderScreen(<DocDetailScreen />);
  await fireEvent.press(await screen.findByText('다운로드'));
  await fireEvent.press(screen.getByText('정리본 (.md)'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe(
      '정리본을 저장하지 못했어요. 기기 저장 공간을 확인해 주세요',
    ),
  );
});

it('원본 받기가 실패하면 전처럼 연결을 확인하라고 알린다', async () => {
  mockApi.content.downloadUrl.mockRejectedValueOnce(new Error('net'));
  await renderScreen(<DocDetailScreen />);
  await fireEvent.press(await screen.findByText('다운로드'));
  await fireEvent.press(screen.getByText('원본 파일'));
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('다운로드하지 못했어요. 연결을 확인해 주세요'),
  );
});

// iOS QA(TC-NOTE-021, 2026-11-21): 고르기 시트(Modal)가 닫히는 중에 공유 시트를 띄우면 Modal과 함께 사라져
// shareAsync가 끝나지 않았다(스피너가 계속 돌고 완료 화면이 안 뜸) → 시트가 다 닫힌 뒤에 띄운다
it('공유 시트는 고르기 시트가 다 닫힌 뒤에 띄운다', async () => {
  const g = globalThis as { MODAL_CLOSE_MS?: number };
  g.MODAL_CLOSE_MS = 300;
  try {
    await renderScreen(<DocDetailScreen />);
    await fireEvent.press(await screen.findByText('다운로드'));
    await fireEvent.press(screen.getByText('정리본 (.md)'));
    await new Promise((r) => setTimeout(r, 100));
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalled());
  } finally {
    delete g.MODAL_CLOSE_MS;
  }
});
