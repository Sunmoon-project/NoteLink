import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { Folder, Material, StudyRoom } from '@notelink/shared';
import { FolderScreen, NoteListScreen } from '../features/content/notes';
import { RoomListScreen } from '../features/studyroom/room';
import { api } from '../lib/api';
import { useQuizProgress } from '../stores/quiz-progress';
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
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

afterEach(() => jest.restoreAllMocks());

// 사용자 보고: 폴더 · 자료 · 스터디룸을 지우려면 반드시 그 안에 들어가야 했다
const folder = {
  _id: 'f1',
  title: '수학 폴더',
  subjectName: '수학',
  createdAt: '2026-11-18T00:00:00Z',
  materialCount: 1,
} as unknown as Folder & { materialCount: number };
const material = {
  _id: 'm1',
  folderId: 'f1',
  title: '미적분 노트',
  kind: 'handwriting',
  createdAt: '2026-11-18T00:00:00Z',
  processing: { status: 'done', progress: 100, jobId: null },
} as unknown as Material;

it('폴더를 꾹 누르면 삭제 확인이 뜨고, 삭제를 누르면 그 폴더를 지운다', async () => {
  jest.spyOn(api.content, 'folders').mockResolvedValue([folder]);
  const del = jest.spyOn(api.content, 'deleteFolder').mockResolvedValue();
  await renderScreen(<NoteListScreen />);
  await fireEvent(await screen.findByText('수학 폴더'), 'longPress');
  expect(await screen.findByText('폴더를 삭제할까요?')).toBeTruthy();
  await fireEvent.press(screen.getByText('삭제'));
  await waitFor(() => expect(del).toHaveBeenCalledWith('f1'));
});

// 폴더를 지우면 서버가 그 폴더의 퀴즈 · 카드 · 보관함도 지우므로 퀴즈 탭 캐시도 새로 읽는다(#602)
const QUIZ_KEYS = ['folders', 'quiz-sets', 'quiz-set', 'flashcards', 'quiz-box', 'today-review'];
const refreshed = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(([f]) => (f as { queryKey: string[] }).queryKey[0]);

it('폴더 목록에서 폴더를 지우면 퀴즈 세트 · 플래시카드 · 보관함 · 오늘의 복습 캐시도 새로 읽는다', async () => {
  jest.spyOn(api.content, 'folders').mockResolvedValue([folder]);
  jest.spyOn(api.content, 'deleteFolder').mockResolvedValue();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  await renderScreen(<NoteListScreen />, qc);
  await fireEvent(await screen.findByText('수학 폴더'), 'longPress');
  await fireEvent.press(await screen.findByText('삭제'));
  await waitFor(() => expect(refreshed(invalidate)).toEqual(expect.arrayContaining(QUIZ_KEYS)));
});

describe('풀던 퀴즈 진행(퀴즈 홈 「이어서 풀기」, code-review 3차)', () => {
  const progressOn = (setId: string) =>
    useQuizProgress.getState().save({
      setId,
      attemptId: 'a1',
      index: 1,
      answerText: '',
      pick: null,
      right: null,
      results: [true],
    });
  const deleteWith = async (sets: Record<string, unknown>[]) => {
    jest.spyOn(api.content, 'folders').mockResolvedValue([folder]);
    jest.spyOn(api.content, 'deleteFolder').mockResolvedValue();
    // 지운 뒤 다시 읽는 목록에는 지운 세트가 없다
    jest.spyOn(api.quiz, 'sets').mockResolvedValue([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['quiz-sets'], sets);
    await renderScreen(<NoteListScreen />, qc);
    await fireEvent(await screen.findByText('수학 폴더'), 'longPress');
    await fireEvent.press(await screen.findByText('삭제'));
    await waitFor(() => expect(api.content.deleteFolder).toHaveBeenCalledWith('f1'));
    await screen.findByText('폴더를 삭제했어요').catch(() => undefined);
  };
  afterEach(() => useQuizProgress.getState().reset());

  it('지운 폴더의 세트를 풀던 진행은 지운다', async () => {
    progressOn('s1');
    await deleteWith([{ _id: 's1', folderId: 'f1', sourceSetId: null }]);
    await waitFor(() => expect(useQuizProgress.getState().progress).toBeNull());
  });

  it('다른 폴더 세트 · 오늘의 복습(서버가 남김)을 풀던 진행은 남긴다', async () => {
    progressOn('today');
    await deleteWith([
      { _id: 'today', folderId: 'f1', sourceSetId: null, reviewDay: '2026-11-20' },
      { _id: 'other', folderId: 'f2', sourceSetId: null },
    ]);
    expect(useQuizProgress.getState().progress?.setId).toBe('today');
    progressOn('other');
    await deleteWith([{ _id: 'other', folderId: 'f2', sourceSetId: null }]);
    expect(useQuizProgress.getState().progress?.setId).toBe('other');
  });
});

it('폴더 안 메뉴에서 폴더를 지워도 퀴즈 탭 캐시를 새로 읽는다', async () => {
  jest.spyOn(api.content, 'folders').mockResolvedValue([folder]);
  jest.spyOn(api.content, 'materials').mockResolvedValue([]);
  jest.spyOn(api.content, 'deleteFolder').mockResolvedValue();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  setParams({ id: 'f1' });
  await renderScreen(<FolderScreen />, qc);
  await fireEvent.press(await screen.findByLabelText('폴더 옵션'));
  await fireEvent.press(await screen.findByText('폴더 삭제'));
  await fireEvent.press(await screen.findByText('삭제'));
  await waitFor(() => expect(refreshed(invalidate)).toEqual(expect.arrayContaining(QUIZ_KEYS)));
});

it('자료를 왼쪽으로 밀면 나오는 삭제 버튼을 누르면 확인 뒤 그 자료를 지운다', async () => {
  jest.spyOn(api.content, 'folders').mockResolvedValue([folder]);
  jest.spyOn(api.content, 'materials').mockResolvedValue([material]);
  const del = jest.spyOn(api.content, 'deleteMaterial').mockResolvedValue();
  setParams({ id: 'f1' });
  await renderScreen(<FolderScreen />);
  await fireEvent.press(await screen.findByLabelText('미적분 노트 삭제'));
  expect(await screen.findByText('자료를 삭제할까요?')).toBeTruthy();
  // 확인 전에는 지우지 않는다
  expect(del).not.toHaveBeenCalled();
  // 밀면 나오는 버튼도 「삭제」라 마지막(대화상자) 것을 누른다
  await fireEvent.press(screen.getAllByText('삭제').at(-1)!);
  await waitFor(() => expect(del).toHaveBeenCalledWith('m1'));
});

it('스터디룸 목록에서 왼쪽으로 밀면 나오는 나가기 버튼을 누르면 확인 뒤 방에서 나간다', async () => {
  const room = {
    _id: 'r1',
    title: '알고리즘 스터디',
    inviteCode: 'AB3F9K',
    memberCount: 2,
    members: [],
  } as unknown as StudyRoom;
  jest.spyOn(api.rooms, 'mine').mockResolvedValue([room]);
  jest.spyOn(api.rooms, 'recommended').mockResolvedValue([]);
  const leave = jest.spyOn(api.rooms, 'leave').mockResolvedValue();
  await renderScreen(<RoomListScreen />);
  await fireEvent.press(await screen.findByLabelText('알고리즘 스터디 나가기'));
  expect(await screen.findByText('스터디룸에서 나갈까요?')).toBeTruthy();
  expect(leave).not.toHaveBeenCalled();
  await fireEvent.press(screen.getAllByText('나가기').at(-1)!);
  await waitFor(() => expect(leave).toHaveBeenCalledWith('r1'));
});

// 사용자 보고: 밀면 나오는 삭제 버튼이 반쯤 잘린 것처럼 보였다 — 빨간 칸이 줄 높이를 채우지 못하고 글자 높이만큼만 칠해졌다
// (눌림 Pressable은 폭을 바깥 상자에, 배경을 안쪽에 나눠 안쪽이 높이를 못 채웠다) → 폭 · 배경이 한 칸에 있어 줄 높이로 늘어난다
it('밀면 나오는 버튼은 폭과 빨간 배경이 같은 칸이라 줄 높이를 꽉 채운다', async () => {
  const { SwipeAction } = jest.requireActual<typeof import('../components/ui')>('../components/ui');
  const { render } = jest.requireActual<typeof import('@testing-library/react-native')>(
    '@testing-library/react-native',
  );
  await render(
    <SwipeAction label="삭제" name="자료" onAction={() => {}}>
      {null}
    </SwipeAction>,
  );
  const cls = String(screen.getByLabelText('자료 삭제').props.className);
  expect(cls).toContain('bg-danger');
  expect(cls).toContain('w-20');
});
