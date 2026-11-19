import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import { DocDetailScreen, summaryMarkdown } from '../features/content/detail';
import { renderScreen, setParams } from '../test-utils';

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
