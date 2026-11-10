import { AccessibilityInfo, Keyboard, Platform } from 'react-native';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ERROR_CODES, NoteAskBody, type AiJob } from '@notelink/shared';
import { ApiError } from '../lib/api/http';
import { localAnswer } from '../lib/local/tutor';
import { TutorBuddy, useTuckOnScroll } from '../features/tutor/buddy';
import { TutorScreen } from '../features/tutor/tutor';
import { renderScreen, setParams } from '../test-utils';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
  useFocusEffect: () => {},
}));
// GL · 3D 모델은 기기에서만. 화면 테스트는 어떤 아바타를 그리는지와 대화 흐름을 본다
jest.mock('../features/tutor/avatar3d', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { Avatar3D: ({ avatarId }: { avatarId: string }) => <T>{`3D:${avatarId}`}</T> };
});

const mockApi = {
  content: { material: jest.fn(), ask: jest.fn() },
  ai: { job: jest.fn() },
  shop: { myItems: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

const job = (over: Partial<AiJob> = {}): AiJob => ({
  _id: 'job1',
  type: 'note_ask',
  status: 'succeeded',
  targetType: 'material',
  targetId: 'm1',
  progress: 100,
  attempts: 1,
  result: { answer: '네 가지 조건이 있어요.', refs: ['교착 상태'] },
  error: null,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // 동작 줄이기: 답을 한 번에 보여 준다(글자 흘리기 타이머 없이)
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  setParams({ id: 'm1' });
  mockApi.content.material.mockResolvedValue({ _id: 'm1', title: '운영체제 3주차' });
  mockApi.shop.myItems.mockResolvedValue([]);
});

describe('아바타 선생님 대화', () => {
  it('추천 질문을 누르면 묻고, 답과 근거 소제목을 보여 준다', async () => {
    mockApi.content.ask.mockResolvedValue(job());
    await renderScreen(<TutorScreen />);
    expect(await screen.findByText('운영체제 3주차')).toBeTruthy();
    await fireEvent.press(screen.getByText('이 노트 핵심만 알려 주세요'));
    expect(await screen.findByText('네 가지 조건이 있어요.')).toBeTruthy();
    expect(screen.getByText('근거 · 교착 상태')).toBeTruthy();
    expect(mockApi.content.ask).toHaveBeenCalledWith('m1', {
      question: '이 노트 핵심만 알려 주세요',
      history: [],
    });
  });

  it('처리 중인 작업은 끝날 때까지 기다린다', async () => {
    mockApi.content.ask.mockResolvedValue(job({ status: 'queued', result: null }));
    mockApi.ai.job.mockResolvedValue(job());
    await renderScreen(<TutorScreen />);
    await fireEvent.changeText(
      await screen.findByPlaceholderText('노트에 대해 물어보기'),
      '조건은요?',
    );
    await fireEvent.press(screen.getByLabelText('질문 보내기'));
    expect(screen.getByText('조건은요?')).toBeTruthy();
    // 큰 무대 · 접힌 무대 두 자리에 같은 상태가 있다
    expect((await screen.findAllByText('노트를 살펴보는 중이에요')).length).toBeGreaterThan(0);
    expect(await screen.findByText('네 가지 조건이 있어요.', {}, { timeout: 4000 })).toBeTruthy();
    expect(mockApi.ai.job).toHaveBeenCalledWith('job1');
  });

  it('앞선 대화를 함께 보내고, 실패 안내는 대화에서 뺀다', async () => {
    mockApi.content.ask
      .mockRejectedValueOnce(new ApiError(ERROR_CODES.NOTE_NOT_READY, 'x', 409))
      .mockResolvedValueOnce(job());
    await renderScreen(<TutorScreen />);
    const input = await screen.findByPlaceholderText('노트에 대해 물어보기');
    await fireEvent.changeText(input, '첫 질문');
    await fireEvent.press(screen.getByLabelText('질문 보내기'));
    expect(await screen.findByText('노트 정리가 끝나면 설명해 드릴게요.')).toBeTruthy();
    await fireEvent.changeText(input, '둘째 질문');
    await fireEvent.press(screen.getByLabelText('질문 보내기'));
    await waitFor(() => expect(mockApi.content.ask).toHaveBeenCalledTimes(2));
    expect(mockApi.content.ask.mock.calls[1]![1]).toEqual({
      question: '둘째 질문',
      history: [{ role: 'user', text: '첫 질문' }],
    });
  });

  it('답을 만들지 못한 작업은 다시 물어보라고 안내한다', async () => {
    mockApi.content.ask.mockResolvedValue(job({ status: 'failed', result: null }));
    await renderScreen(<TutorScreen />);
    await fireEvent.press(await screen.findByText('시험에 나올 만한 건요?'));
    expect(
      await screen.findByText('답을 만들지 못했어요. 연결을 확인하고 다시 물어봐 주세요.'),
    ).toBeTruthy();
  });

  it('긴 답은 서버 계약(한 턴 600자)에 맞게 앞부분만 이력으로 보낸다', async () => {
    const long = '가'.repeat(900);
    mockApi.content.ask
      .mockResolvedValueOnce(job({ result: { answer: long, refs: [] } }))
      .mockResolvedValueOnce(job());
    await renderScreen(<TutorScreen />);
    await fireEvent.press(await screen.findByText('시험에 나올 만한 건요?'));
    await screen.findByText(long);
    await fireEvent.changeText(screen.getByPlaceholderText('노트에 대해 물어보기'), '더 짧게요');
    await fireEvent.press(screen.getByLabelText('질문 보내기'));
    await waitFor(() => expect(mockApi.content.ask).toHaveBeenCalledTimes(2));
    const body = mockApi.content.ask.mock.calls[1]![1];
    expect(body.history[1]).toEqual({ role: 'avatar', text: '가'.repeat(600) });
    expect(NoteAskBody.safeParse(body).success).toBe(true);
  });

  it('서버에 묻기 경로가 아직 없으면(404) 준비 중이라고 안내한다', async () => {
    mockApi.content.ask.mockRejectedValue(new ApiError(ERROR_CODES.NOT_FOUND, 'Cannot POST', 404));
    await renderScreen(<TutorScreen />);
    await fireEvent.press(await screen.findByText('시험에 나올 만한 건요?'));
    expect(await screen.findByText('아바타에게 묻기는 준비 중이에요. 곧 열려요.')).toBeTruthy();
  });

  it('장착한 상점 아바타의 3D 모델을 쓰고, 없으면 기본 아바타', async () => {
    mockApi.shop.myItems.mockResolvedValue([
      { itemId: 'jihoo', itemCategory: 'avatar', isOwned: true, isEquipped: false },
      { itemId: 'bora', itemCategory: 'avatar', isOwned: true, isEquipped: true },
    ]);
    await renderScreen(<TutorScreen />);
    expect(await screen.findByText('3D:bora')).toBeTruthy();
  });
});

// 안드로이드에는 Will 이벤트가 오지 않는다 — Did를 들어야 첫 질문을 쓸 때 큰 무대가 접힌다
it('안드로이드에서는 keyboardDidShow · keyboardDidHide로 키보드를 본다', async () => {
  const was = Platform.OS;
  Platform.OS = 'android';
  const listen = jest.spyOn(Keyboard, 'addListener');
  try {
    await renderScreen(<TutorScreen />);
    await screen.findByText('운영체제 3주차');
    const events = listen.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['keyboardDidShow', 'keyboardDidHide']));
    expect(events).not.toContain('keyboardWillShow');
    expect(events).not.toContain('keyboardWillHide');
  } finally {
    Platform.OS = was;
    listen.mockRestore();
  }
});

describe('노트 상세에 떠 있는 아바타 선생님', () => {
  it('누르면 아바타 선생님 화면을 열고, 처음에 할 일을 말풍선으로 알려 준다', async () => {
    await renderScreen(<TutorBuddy id="m1" tucked={false} />);
    expect(await screen.findByText('3D:base')).toBeTruthy();
    expect(await screen.findByText('노트를 물어보세요', {}, { timeout: 3000 })).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('아바타 선생님에게 물어보기'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/tutor/[id]', params: { id: 'm1' } });
  });

  it('아래로 읽어 내려가면 비켜 서고, 위로 올리거나 잠시 멈추면 돌아온다', async () => {
    jest.useFakeTimers();
    const { result } = await renderHook(() => useTuckOnScroll(1200));
    const at = (y: number) =>
      act(async () => result.current.onScroll({ nativeEvent: { contentOffset: { y } } } as never));
    await at(10);
    expect(result.current.tucked).toBe(false); // 맨 위 근처에서는 그대로
    await at(80);
    expect(result.current.tucked).toBe(true);
    await at(60);
    expect(result.current.tucked).toBe(false);
    await at(160);
    expect(result.current.tucked).toBe(true);
    await act(async () => jest.advanceTimersByTime(1200));
    expect(result.current.tucked).toBe(false);
    jest.useRealTimers();
  });
});

describe('기기 저장 모드의 아바타 답', () => {
  const note = {
    summary: {
      sections: [
        {
          heading: '교착 상태',
          body: '네 가지 조건이 모두 있어야 생긴다. 하나를 깨면 막는다. 끝.',
        },
        { heading: '스케줄링', body: '라운드 로빈은 시간 조각으로 돌린다.' },
      ],
      points: ['상호 배제'],
    },
    pages: [
      { pageNo: 2, imageUrl: '', sizeBytes: 1, ocrText: '페이지 교체 알고리즘', takenAt: null },
    ],
  };

  it('질문 낱말이 가장 많이 겹치는 부분을 두 문장까지 읽어 준다', () => {
    expect(localAnswer(note, '라운드로빈 스케줄링은요?')).toEqual({
      answer: "노트의 '스케줄링' 부분을 보면, 라운드 로빈은 시간 조각으로 돌린다.",
      refs: ['스케줄링'],
    });
    expect(localAnswer(note, '교착상태 조건')!.answer).toBe(
      "노트의 '교착 상태' 부분을 보면, 네 가지 조건이 모두 있어야 생긴다. 하나를 깨면 막는다.",
    );
    expect(localAnswer(note, '페이지 교체')!.refs).toEqual(['2쪽']);
  });

  it('겹치는 곳이 없으면 요약 질문은 첫 부분을, 그 밖은 노트에 없다고 답한다', () => {
    expect(localAnswer(note, '핵심 알려 주세요')!.refs).toEqual(['핵심']);
    expect(localAnswer(note, '설명해 주세요')!.refs).toEqual(['교착 상태']);
    expect(localAnswer(note, '양자역학')).toEqual({
      answer: '노트에는 없는 내용이에요. 서버에 연결되면 더 자세히 설명해 드릴게요.',
      refs: [],
    });
  });

  it('글이 없는 노트는 null(서버의 NOTE_NOT_READY)', () => {
    expect(localAnswer({ summary: null, pages: [] }, '뭐예요?')).toBeNull();
  });
});
