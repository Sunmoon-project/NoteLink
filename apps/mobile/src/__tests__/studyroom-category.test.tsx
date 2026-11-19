import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { StudyRoom } from '@notelink/shared';
import { router } from 'expo-router';
import { RoomCreateScreen, RoomListScreen } from '../features/studyroom/room';
import { api } from '../lib/api';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

// 스터디룸 카테고리 여러 개 · 추천 카드에 카테고리 · 대상 표시 (#550)
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

afterEach(() => jest.restoreAllMocks());

const CATEGORIES = ['코딩', '영어', '수학', '자격증'].map((name, i) => ({
  _id: `c${i + 1}`,
  name,
  parentId: null,
}));

describe('스터디룸 만들기 카테고리', () => {
  beforeEach(() => {
    jest.spyOn(api.me, 'interestCategories').mockResolvedValue(CATEGORIES);
  });

  it('관심 분야 선택기로 고른 순서대로 categoryIds를 보내고, 고르기 전에는 만들 수 없다', async () => {
    const create = jest
      .spyOn(api.rooms, 'create')
      .mockResolvedValue({ _id: 'new-room', inviteCode: 'AB1234' } as StudyRoom);
    await renderScreen(<RoomCreateScreen />);
    await fireEvent.changeText(
      screen.getByPlaceholderText('예) 파이썬 기초 스터디'),
      ' 영어 코딩 ',
    );
    await screen.findByText('영어');
    const submit = () => screen.getByRole('button', { name: '스터디룸 만들기' });
    expect(submit()).toBeDisabled();
    await fireEvent.press(screen.getByText('영어'));
    await fireEvent.press(screen.getByText('코딩'));
    await fireEvent.press(submit());
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        title: '영어 코딩',
        categoryIds: ['c2', 'c1'],
        isPublic: true,
      }),
    );
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith({
        pathname: '/room/[id]',
        params: { id: 'new-room' },
      }),
    );
  });

  it('3개까지만 고를 수 있고, 넘으면 안내한다 · 다시 누르면 풀린다', async () => {
    const create = jest
      .spyOn(api.rooms, 'create')
      .mockResolvedValue({ _id: 'new-room', inviteCode: 'AB1234' } as StudyRoom);
    await renderScreen(<RoomCreateScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('예) 파이썬 기초 스터디'), '방');
    await screen.findByText('자격증');
    for (const name of ['코딩', '영어', '수학', '자격증'])
      await fireEvent.press(screen.getByText(name));
    expect(useToast.getState().msg).toBe('카테고리는 3개까지 고를 수 있어요');
    await fireEvent.press(screen.getByText('영어'));
    await fireEvent.press(screen.getByText('자격증'));
    await fireEvent.press(screen.getByRole('button', { name: '스터디룸 만들기' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryIds: ['c1', 'c3', 'c4'] }),
      ),
    );
  });
});

describe('스터디룸 카드의 카테고리 · 대상', () => {
  const room = (over: Partial<StudyRoom>) =>
    ({
      _id: 'r',
      title: '방',
      inviteCode: 'AB3F9K',
      memberCount: 2,
      members: [],
      ...over,
    }) as StudyRoom;

  it('추천 · 내 방 카드에 카테고리 이름과 대상(중·고등학생 / 대학생 / 직장인)을 보인다', async () => {
    jest.spyOn(api.rooms, 'mine').mockResolvedValue([
      room({
        _id: 'm1',
        title: '내 토익방',
        categoryNames: ['토익'],
        learnerType: 'worker',
      }),
    ]);
    jest.spyOn(api.rooms, 'recommended').mockResolvedValue([
      room({
        _id: 'r1',
        title: '추천 코딩방',
        categoryNames: ['코딩', '영어'],
        learnerType: 'middle_high',
      }),
      // 예전 응답(categoryNames 없음 · 대상 미지정)은 categoryName 하나만, 대상 배지 없이
      room({ _id: 'r2', title: '예전 방', categoryName: '수능', learnerType: null }),
    ]);
    await renderScreen(<RoomListScreen />);
    await screen.findByText('추천 코딩방');
    for (const text of ['토익', '직장인', '코딩', '영어', '중·고등학생', '수능'])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText('대학생')).toBeNull();
  });
});
