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

afterEach(() => jest.useRealTimers());

it('시트를 닫으며 여는 확인 창은 시트가 다 닫힌 뒤에 뜬다 (iOS가 겹친 Modal을 무시함)', async () => {
  await renderScreen(<SheetThenDialog />);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  await fireEvent.press(await screen.findByText('다음으로'));
  expect(screen.queryByText('확인 창')).toBeNull();
  await act(async () => void jest.advanceTimersByTime(400));
  expect(screen.getByText('확인 창')).toBeTruthy();
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
