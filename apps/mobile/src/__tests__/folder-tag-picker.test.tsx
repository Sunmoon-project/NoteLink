import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { NoteTagScreen, NoteTitleScreen } from '../features/content/notes';
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

afterEach(() => jest.restoreAllMocks());

// 사용자 요청: 새 폴더의 태그도 관심 분야 화면처럼 칩으로 떠서 눌러 고르게
it('새 폴더 태그는 관심 분야 목록을 칩으로 보이고, 고른 분야 이름으로 다음 단계로 간다', async () => {
  jest.spyOn(api.me, 'interestCategories').mockResolvedValue([
    { _id: 'c1', name: '자격증', parentId: null },
    { _id: 'c2', name: '코딩', parentId: null },
  ]);
  await renderScreen(<NoteTagScreen />);
  await fireEvent.press(await screen.findByText('코딩'));
  await fireEvent.press(screen.getByText('다음'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/note-new/title',
    params: { tag: '코딩' },
  });
});

it('고른 태그는 폴더 만들기 요청의 과목(subjectName)으로 저장된다', async () => {
  const create = jest
    .spyOn(api.content, 'createFolder')
    .mockResolvedValue({ _id: 'f9' } as Awaited<ReturnType<typeof api.content.createFolder>>);
  setParams({ tag: '코딩' });
  await renderScreen(<NoteTitleScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('폴더 이름을 입력해 주세요'), '알고리즘');
  await fireEvent.press(screen.getByText('완료'));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ title: '알고리즘', subjectName: '코딩' }),
  );
});
