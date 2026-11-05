import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { NoteTitleScreen } from '../features/content/notes';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => jest.restoreAllMocks());

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
