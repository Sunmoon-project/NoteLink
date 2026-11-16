import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { NoteTitleScreen } from '../features/content/notes';
import { api } from '../lib/api';
import { router } from 'expo-router';
import { useTour } from '../features/tutor/tour';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('새 자료 제목은 비어 있고, 입력해야 만들 수 있다', async () => {
  const create = jest.spyOn(api.content, 'createFolder');
  setParams({ tag: '영어' });
  await renderScreen(<NoteTitleScreen />);
  expect(screen.queryByDisplayValue(/이차방정식/)).toBeNull();
  expect(screen.getByRole('button', { name: '완료' })).toBeDisabled();
  await fireEvent.changeText(screen.getByPlaceholderText('폴더 이름을 입력해 주세요'), '영어 단어');
  await fireEvent.press(screen.getByRole('button', { name: '완료' }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({ title: '영어 단어', subjectName: '영어' }),
  );
});

it('처음 안내에서 왔으면 만든 폴더로 들어가 + 버튼 안내를 이어 연다', async () => {
  jest.spyOn(api.content, 'createFolder').mockResolvedValue({ _id: 'f-new' } as never);
  useTour.setState({ step: -1, kind: 'main', afterFolder: true });
  setParams({ tag: '과학' });
  await renderScreen(<NoteTitleScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('폴더 이름을 입력해 주세요'), '광합성');
  await fireEvent.press(screen.getByRole('button', { name: '완료' }));
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/note/folder/[id]',
      params: { id: 'f-new' },
    }),
  );
  expect(useTour.getState()).toMatchObject({ kind: 'folder', step: 0, afterFolder: false });
});

it('안내 없이 만든 폴더는 목록으로만 돌아간다', async () => {
  jest.spyOn(api.content, 'createFolder').mockResolvedValue({ _id: 'f2' } as never);
  useTour.setState({ step: -1, kind: 'main', afterFolder: false });
  setParams({ tag: '영어' });
  await renderScreen(<NoteTitleScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('폴더 이름을 입력해 주세요'), '단어');
  await fireEvent.press(screen.getByRole('button', { name: '완료' }));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/note'));
  expect(router.push).not.toHaveBeenCalled();
  expect(useTour.getState().step).toBe(-1);
});
