import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api } from '../lib/api';
import { HomeScreen } from '../features/session/home';
import { itemInput } from '../features/session/sheets';
import { useSession } from '../stores/session';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: { addListener: () => ({ remove() {} }), setUpdateInterval() {} },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));

// PR #34 리뷰
describe('공부할 항목 추가 입력', () => {
  const base = {
    title: '이차방정식',
    subject: '수학',
    newSubject: '',
    goal: '1시간' as const,
    customMin: '',
  };
  it('새 과목은 입력한 이름으로 저장한다', () => {
    expect(itemInput({ ...base, subject: '+ 새 과목', newSubject: ' 물리 ' })).toMatchObject({
      subjectName: '물리',
    });
    expect(itemInput({ ...base, subject: '+ 새 과목', newSubject: '' })).toBe(
      '과목 이름을 입력해 주세요',
    );
  });
  it('직접 입력한 목표 시간을 1 ~ 1440분 안에서 저장한다', () => {
    expect(itemInput({ ...base, goal: '직접 입력', customMin: '75' })).toMatchObject({
      goalMin: 75,
    });
    expect(typeof itemInput({ ...base, goal: '직접 입력', customMin: '' })).toBe('string');
    expect(typeof itemInput({ ...base, goal: '직접 입력', customMin: '1441' })).toBe('string');
  });
  it('목표는 생략할 수 있고, 공부할 내용은 비울 수 없다', () => {
    expect(itemInput({ ...base, goal: null })).toMatchObject({ goalMin: null });
    expect(itemInput({ ...base, title: '  ' })).toBe('공부할 내용을 입력해 주세요');
  });
});

describe('측정 항목 전환', () => {
  it('다른 항목으로 바꾸면 서버 누적을 다시 받는다', async () => {
    useSession.getState().reset();
    const a = await api.study.addItem({ title: '가정법', subjectName: '영어', goalMin: 30 });
    const b = await api.study.addItem({ title: '미분', subjectName: '수학', goalMin: 30 });
    const today = jest.spyOn(api.study, 'today');
    await renderScreen(<HomeScreen />);
    await fireEvent.press(await screen.findByLabelText(`${a.title} 시작`));
    await waitFor(() => expect(useSession.getState().sessionId).not.toBeNull(), { timeout: 3000 });
    const before = today.mock.calls.length;
    await fireEvent.press(screen.getByLabelText(`${b.title} 시작`));
    await waitFor(() => expect(useSession.getState().itemId).toBe(b._id));
    await waitFor(() => expect(today.mock.calls.length).toBeGreaterThan(before), { timeout: 3000 });
    await act(async () => useSession.getState().reset());
  });
});
