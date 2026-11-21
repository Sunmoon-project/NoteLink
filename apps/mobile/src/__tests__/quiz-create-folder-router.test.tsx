import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { Material } from '@notelink/shared';
import { QuizNotesScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { DEMO_FOLDER, makeMaterial } from './fixtures/seed';

// #575 Codex 1차 제안: 목이 아닌 실제 Stack에서 폴더 → 자료 → 뒤로 가기가 1단계로 돌아오는지 본다
jest.mock('expo-router', () => jest.requireActual('expo-router'));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

const FOLDERS = [
  { ...DEMO_FOLDER, _id: 'fA', title: '수학 폴더', materialCount: 1 },
  { ...DEMO_FOLDER, _id: 'fB', title: '영어 폴더', materialCount: 1 },
];
const MATERIALS: Record<string, Material[]> = {
  fA: [makeMaterial('fA', 'handwriting', { _id: 'mA1', title: '근의 공식 정리' })],
  fB: [makeMaterial('fB', 'document', { _id: 'mB1', title: '영어 단어장' })],
};

afterEach(() => {
  jest.restoreAllMocks();
  // renderRouter가 켠 가짜 타이머를 다음 시험으로 넘기지 않는다
  jest.useRealTimers();
});

it('실제 Stack에서 폴더를 누르면 2단계가 쌓이고, 뒤로 가면 1단계 폴더 목록으로 돌아온다', async () => {
  jest.spyOn(api.content, 'folders').mockResolvedValue(FOLDERS as never);
  jest
    .spyOn(api.content, 'materials')
    .mockImplementation(async (id: string) => MATERIALS[id] ?? []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // render가 비동기라 결과(경로 확인 함수)를 먼저 받아 두고 기다린다
  const app = renderRouter(
    {
      _layout: () => (
        <QueryClientProvider client={qc}>
          <Stack screenOptions={{ headerShown: false }} />
        </QueryClientProvider>
      ),
      '(tabs)/quiz/notes': QuizNotesScreen,
    },
    { initialUrl: '/quiz/notes' },
  );
  await app;
  await fireEvent.press(await screen.findByText('수학 폴더'));
  // 2단계: 그 폴더의 자료만, 경로는 그대로이고 파라미터만 붙는다
  expect(await screen.findByText('근의 공식 정리')).toBeTruthy();
  expect(app.getPathname()).toBe('/quiz/notes');
  expect(app.getSearchParams()).toEqual({ folderId: 'fA' });
  expect(screen.queryByText('영어 단어장')).toBeNull();
  expect(router.canGoBack()).toBe(true);
  await act(async () => router.back());
  // 1단계로 돌아와 폴더 카드가 다시 보이고 자료는 보이지 않는다
  expect(await screen.findByText('영어 폴더')).toBeTruthy();
  expect(app.getPathname()).toBe('/quiz/notes');
  expect(app.getSearchParams()).toEqual({});
  expect(screen.queryByText('근의 공식 정리')).toBeNull();
});
