import { useState } from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { afterSheetClosed, Avatar, Dialog, Sheet } from '../components/ui';
import { renderScreen } from '../test-utils';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

function SheetThenDialog() {
  const [step, setStep] = useState<'sheet' | 'dialog'>('sheet');
  return (
    <>
      <Sheet open={step === 'sheet'} onClose={() => {}}>
        <Pressable onPress={() => setStep('dialog')}>
          <Text>다음으로</Text>
        </Pressable>
      </Sheet>
      <Dialog open={step === 'dialog'}>
        <Text>확인 창</Text>
      </Dialog>
    </>
  );
}

const testGlobal = globalThis as { MODAL_CLOSE_MS?: number };
beforeEach(() => {
  delete testGlobal.MODAL_CLOSE_MS;
});
afterEach(() => {
  testGlobal.MODAL_CLOSE_MS = 0;
  jest.useRealTimers();
});

it('시트를 닫으며 여는 확인 창은 시트가 다 닫힌 뒤에 뜬다 (iOS가 겹친 Modal을 무시함)', async () => {
  await renderScreen(<SheetThenDialog />);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  await fireEvent.press(await screen.findByText('다음으로'));
  expect(screen.queryByText('확인 창')).toBeNull();
  await act(async () => void jest.advanceTimersByTime(400));
  expect(screen.getByText('확인 창')).toBeTruthy();
});

// 날짜 시트(앞) → 할 일 추가 시트(뒤) → 추가 후 날짜 시트로 돌아오기: 앞에 그려지는 시트가 다시 열릴 때도
// 뒤 시트가 다 닫힌 뒤에 떠야 한다. 먼저 뜨면 iOS가 겹친 Modal을 버려, 그 뒤로 날짜를 눌러도 아무 반응이 없었다
function BackToEarlierSheet() {
  const [step, setStep] = useState<'list' | 'add'>('add');
  return (
    <>
      <Sheet open={step === 'list'} onClose={() => {}}>
        <Text>날짜별 할 일</Text>
      </Sheet>
      <Sheet open={step === 'add'} onClose={() => {}}>
        <Pressable onPress={() => setStep('list')}>
          <Text>추가하기</Text>
        </Pressable>
      </Sheet>
    </>
  );
}

it('앞에 그려지는 시트로 돌아갈 때도 뒤 시트가 다 닫힌 뒤에 뜬다', async () => {
  await renderScreen(<BackToEarlierSheet />);
  // 앞 시험에서 닫힌 시트의 닫힘 시간이 남아 있으면 이 시험이 우연히 통과한다. 다 지나간 뒤에 시작한다
  await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  await fireEvent.press(await screen.findByText('추가하기'));
  expect(screen.queryByText('날짜별 할 일')).toBeNull();
  await act(async () => void jest.advanceTimersByTime(400));
  expect(screen.getByText('날짜별 할 일')).toBeTruthy();
});

it('afterSheetClosed는 시트가 닫히는 시간만큼 기다린다', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  let done = false;
  void afterSheetClosed().then(() => (done = true));
  await act(async () => void jest.advanceTimersByTime(100));
  expect(done).toBe(false);
  await act(async () => void jest.advanceTimersByTime(300));
  expect(done).toBe(true);
});

it('주소가 아닌 아바타 값은 빈 이미지 대신 글자로 보여 준다', async () => {
  await renderScreen(<Avatar uri="🐻" name="수민" />);
  expect(screen.getByText('🐻')).toBeTruthy();
  expect(screen.queryByLabelText('프로필 사진')).toBeNull();
});

it.each(['record', 'dday', 'holiday', 'repeat', 'timetable', 'cal-share'])(
  '캘린더 화면 %s는 탭 밖에 있어 어느 탭에서 열어도 뒤로 가면 그 탭으로 돌아온다',
  (route) => {
    expect(() => jest.requireActual(`../../app/${route}`)).not.toThrow();
    expect(() => jest.requireActual(`../../app/(tabs)/(home)/${route}`)).toThrow();
  },
);
