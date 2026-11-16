import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { DDay } from '@notelink/shared';
import { DDayScreen } from '../features/progress/goals';
import { HolidayScreen } from '../features/calendar/screens';
import { api } from '../lib/api';
import { today } from '../lib/dates';
import { useAuth } from '../stores/auth';
import { renderScreen } from '../test-utils';

const mockToast = jest.fn();
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
let ddayRecords: DDay[];
let customRecords: { _id: string; name: string; date: string }[];
let publicRecords: { _id: string; name: string; hidden: boolean }[];
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ userId: 'calendar-save-review' });
  ddayRecords = [];
  customRecords = [];
  publicRecords = [{ _id: today(), name: '테스트 공휴일', hidden: false }];
  jest.spyOn(api.calendar, 'ddays').mockImplementation(async () => structuredClone(ddayRecords));
  jest.spyOn(api.calendar, 'addDday').mockImplementation(async ({ title, date }) => {
    const created: DDay = {
      _id: 'created-dday',
      title,
      date,
      source: 'manual',
      kind: '목표일',
      daysLeft: 20,
    };
    ddayRecords.push(created);
    return structuredClone(created);
  });
  jest
    .spyOn(api.calendar, 'customHolidays')
    .mockImplementation(async () => structuredClone(customRecords));
  jest.spyOn(api.calendar, 'addCustomHoliday').mockImplementation(async (holiday) => {
    customRecords.push({ _id: 'created-custom', ...holiday });
  });
  jest.spyOn(api.calendar, 'removeCustomHoliday').mockImplementation(async (id) => {
    customRecords = customRecords.filter((holiday) => holiday._id !== id);
  });
  jest
    .spyOn(api.calendar, 'holidays')
    .mockImplementation(async () => structuredClone(publicRecords));
  jest.spyOn(api.calendar, 'setHolidayHidden').mockImplementation(async (date, hidden) => {
    publicRecords = publicRecords.map((holiday) =>
      holiday._id === date ? { ...holiday, hidden } : holiday,
    );
  });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});
const renderDday = async () => {
  const qc = client();
  const view = await renderScreen(<DDayScreen />, qc);
  await waitFor(() => expect(qc.isFetching()).toBe(0));
  return view;
};
const renderHoliday = async () => {
  const qc = client();
  const view = await renderScreen(<HolidayScreen />, qc);
  await screen.findByText('테스트 공휴일');
  await waitFor(() => expect(qc.isFetching()).toBe(0));
  return view;
};
const fillDday = async () => {
  await fireEvent.press(screen.getByText('+ D-day 추가'));
  await fireEvent.changeText(screen.getByPlaceholderText('예) 기말고사'), '  연구 발표  ');
  await fireEvent.changeText(screen.getByLabelText('D-day 날짜'), '2032-02-29');
};
const fillCustom = async () => {
  await fireEvent.press(screen.getByText('+ 휴일 추가'));
  await fireEvent.changeText(screen.getByPlaceholderText('예) 학교 개교기념일'), '  학교 휴업일  ');
  await fireEvent.changeText(screen.getByLabelText('휴일 날짜'), '2032-09-15');
};
const expectErrorToast = async () => {
  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  expect(String(mockToast.mock.calls.at(-1)?.[0])).toMatch(/못|실패|다시/);
};

describe('PR35 D-day 저장', () => {
  it('입력한 제목·날짜를 보내고 성공 후 새 조회로 생성 결과를 표시한다', async () => {
    await renderDday();
    await fillDday();
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    expect(await screen.findByText('연구 발표')).toBeTruthy();
    expect(api.calendar.addDday).toHaveBeenCalledWith({ title: '연구 발표', date: '2032-02-29' });
    expect(api.calendar.ddays).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/2032\.02\.29/)).toBeTruthy();
    expect(screen.getByText('+ D-day 추가')).toBeTruthy();
  });
  it('실패를 안내하고 입력과 기존 조회 결과를 보존한 채 재시도한다', async () => {
    jest.mocked(api.calendar.addDday).mockRejectedValueOnce(new Error('D-day 저장 실패'));
    await renderDday();
    await fillDday();
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    await expectErrorToast();
    expect(screen.getByPlaceholderText('예) 기말고사').props.value).toBe('  연구 발표  ');
    expect(screen.getByLabelText('D-day 날짜').props.value).toBe('2032-02-29');
    expect(api.calendar.ddays).toHaveBeenCalledTimes(1);
    expect(ddayRecords).toEqual([]);
    expect(mockToast.mock.calls.some(([message]) => String(message).includes('추가했어요'))).toBe(
      false,
    );
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    await screen.findByText('연구 발표');
    expect(api.calendar.addDday).toHaveBeenCalledTimes(2);
    expect(api.calendar.ddays).toHaveBeenCalledTimes(2);
  });
});

describe('PR35 사용자 휴일 생성·삭제', () => {
  it('입력한 이름·날짜로 생성하고 재조회·재진입에도 결과를 표시한다', async () => {
    const view = await renderHoliday();
    await fillCustom();
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    await screen.findByText('학교 휴업일 (9/15)');
    expect(api.calendar.addCustomHoliday).toHaveBeenCalledWith({
      name: '학교 휴업일',
      date: '2032-09-15',
    });
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(2);
    expect(screen.getByText('+ 휴일 추가')).toBeTruthy();
    await view.unmount();
    await renderHoliday();
    expect(screen.getByText('학교 휴업일 (9/15)')).toBeTruthy();
  });
  it('선택한 사용자 휴일 ID만 삭제하고 재조회해 나머지 휴일을 보존한다', async () => {
    customRecords = [
      { _id: 'keep-custom', name: '남길 휴일', date: '2032-01-02' },
      { _id: 'delete-custom', name: '삭제할 휴일', date: '2032-10-02' },
    ];
    const view = await renderHoliday();
    await screen.findByText('삭제할 휴일 (10/2)');
    await fireEvent.press(screen.getAllByLabelText('삭제')[1]!);
    await waitFor(() => expect(screen.queryByText('삭제할 휴일 (10/2)')).toBeNull());
    expect(jest.mocked(api.calendar.removeCustomHoliday).mock.calls[0]?.[0]).toBe('delete-custom');
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(2);
    expect(screen.getByText('남길 휴일 (1/2)')).toBeTruthy();
    await view.unmount();
    await renderHoliday();
    expect(screen.queryByText('삭제할 휴일 (10/2)')).toBeNull();
    expect(screen.getByText('남길 휴일 (1/2)')).toBeTruthy();
  });
  it('생성 실패에는 입력을 보존하고 성공 처리 없이 재시도한다', async () => {
    jest.mocked(api.calendar.addCustomHoliday).mockRejectedValueOnce(new Error('휴일 생성 실패'));
    await renderHoliday();
    await fillCustom();
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    await expectErrorToast();
    expect(screen.getByPlaceholderText('예) 학교 개교기념일').props.value).toBe('  학교 휴업일  ');
    expect(screen.getByLabelText('휴일 날짜').props.value).toBe('2032-09-15');
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(1);
    expect(customRecords).toEqual([]);
    await fireEvent.press(screen.getByRole('button', { name: '추가' }));
    await screen.findByText('학교 휴업일 (9/15)');
    expect(api.calendar.addCustomHoliday).toHaveBeenCalledTimes(2);
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(2);
  });
  it('삭제 실패에는 기존 목록을 유지하고 같은 ID로 재시도한다', async () => {
    customRecords = [{ _id: 'retry-delete', name: '삭제 재시도 휴일', date: '2032-10-02' }];
    jest
      .mocked(api.calendar.removeCustomHoliday)
      .mockRejectedValueOnce(new Error('휴일 삭제 실패'));
    await renderHoliday();
    await screen.findByText('삭제 재시도 휴일 (10/2)');
    await fireEvent.press(screen.getByLabelText('삭제'));
    await expectErrorToast();
    expect(screen.getByText('삭제 재시도 휴일 (10/2)')).toBeTruthy();
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('삭제'));
    await waitFor(() => expect(screen.queryByText('삭제 재시도 휴일 (10/2)')).toBeNull());
    expect(jest.mocked(api.calendar.removeCustomHoliday).mock.calls.map(([id]) => id)).toEqual([
      'retry-delete',
      'retry-delete',
    ]);
    expect(api.calendar.customHolidays).toHaveBeenCalledTimes(2);
  });
});

describe('PR35 공휴일 숨김 저장', () => {
  it('날짜·숨김 값을 보내고 재조회·재진입에 반영하며 다시 표시할 수 있다', async () => {
    const view = await renderHoliday();
    await fireEvent.press(await screen.findByText('표시중'));
    await screen.findByText('숨김');
    expect(api.calendar.setHolidayHidden).toHaveBeenCalledWith(today(), true);
    expect(api.calendar.holidays).toHaveBeenCalledTimes(2);
    await view.unmount();
    await renderHoliday();
    await fireEvent.press(await screen.findByText('숨김'));
    await screen.findByText('표시중');
    expect(api.calendar.setHolidayHidden).toHaveBeenLastCalledWith(today(), false);
    expect(api.calendar.holidays).toHaveBeenCalledTimes(4);
  });
  it('숨김 저장 실패에는 표시 상태를 보존하고 같은 값으로 재시도한다', async () => {
    jest.mocked(api.calendar.setHolidayHidden).mockRejectedValueOnce(new Error('숨김 저장 실패'));
    await renderHoliday();
    await fireEvent.press(await screen.findByText('표시중'));
    await expectErrorToast();
    expect(screen.getByText('표시중')).toBeTruthy();
    expect(screen.queryByText('숨김')).toBeNull();
    expect(api.calendar.holidays).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('표시중'));
    await screen.findByText('숨김');
    expect(api.calendar.setHolidayHidden).toHaveBeenNthCalledWith(1, today(), true);
    expect(api.calendar.setHolidayHidden).toHaveBeenNthCalledWith(2, today(), true);
    expect(api.calendar.holidays).toHaveBeenCalledTimes(2);
  });
});
