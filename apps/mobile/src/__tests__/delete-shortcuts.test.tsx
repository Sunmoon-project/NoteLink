import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Folder, Material, StudyRoom } from '@notelink/shared';
import { FolderScreen, NoteListScreen } from '../features/content/notes';
import { RoomListScreen } from '../features/studyroom/room';
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
