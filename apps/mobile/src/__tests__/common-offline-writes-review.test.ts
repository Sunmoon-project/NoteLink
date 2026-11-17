import { mockApi as api } from './fixtures/api';
import { NetworkError } from '../lib/api/http';
import { useNet } from '../stores/net';
import { useMockFlags } from './fixtures/flags';
import type { TimerRule } from '@notelink/shared';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const date = '2026-11-02';
const ids = {
  item: '',
  session: '',
  folder: '',
  material: '',
  job: '',
  attempt: '',
  todo: '',
  goal: '',
  custom: '',
  share: '',
  lesson: '',
  room: '',
  request: '',
  card: '',
  shop: '',
};
const rule: TimerRule = {
  enabled: true,
  type: 'pomodoro',
  focusMin: 25,
  breakMin: 0,
  repeat: 4,
  periods: [],
};
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await jest.runAllTimersAsync();
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
beforeAll(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(`${date}T00:00:00Z`));
  useNet.setState({ state: 'ok' });
  useMockFlags.getState().reset();
  ids.item = (
    await settle(api.study.addItem({ title: '오프라인 경계', subjectName: '수학', goalMin: null }))
  )._id;
  ids.session = (
    await settle(api.study.startSession({ studyItemId: ids.item, mode: 'personal' }))
  )._id;
  ids.folder = (
    await settle(api.content.createFolder({ title: '보존할 폴더', subjectName: '수학' }))
  )._id;
  const created = await settle(
    api.content.createMaterial({
      folderId: ids.folder,
      kind: 'handwriting',
      source: 'camera',
      title: '보존할 자료',
      blobUrls: [],
    }),
  );
  ids.material = created.material._id;
  ids.job = created.job._id;
  ids.attempt = (await settle(api.quiz.startAttempt('qs1')))._id;
  ids.todo = (
    await settle(
      api.calendar.addTodo({
        content: '보존할 할 일',
        todoType: 'general',
        dueDate: date,
        timeSlot: 'none',
        subjectName: null,
      }),
    )
  )._id;
  ids.goal = (await settle(api.study.saveRecurringGoal({ name: '보존할 목표' })))._id;
  await settle(api.calendar.addCustomHoliday({ name: '보존할 휴일', date }));
  ids.custom = (await settle(api.calendar.customHolidays())).find(
    (x) => x.name === '보존할 휴일',
  )!._id;
  ids.share = (
    await settle(
      api.calendar.createShare({ rangeStart: date, rangeEnd: date, expiresInDays: null }),
    )
  )._id;
  ids.lesson = (
    await settle(
      api.timetable.addClass({
        subjectName: '보존할 수업',
        days: [1],
        startTime: '09:00',
        endTime: '10:00',
        location: '',
        color: '#abcdef',
      }),
    )
  )._id;
  ids.room = (
    await settle(api.rooms.create({ title: '보존할 방', categoryName: '수학', isPublic: true }))
  )._id;
  ids.request = (await settle(api.social.received()))[0]!._id;
  ids.card = (await settle(api.quiz.flashcards()))[0]!._id;
  ids.shop = (await settle(api.shop.items({})))[0]!._id;
});
afterAll(() => {
  useNet.setState({ state: 'ok' });
  jest.clearAllTimers();
  jest.useRealTimers();
});
beforeEach(() => useNet.setState({ state: 'ok' }));
async function snapshot() {
  return settle(
    Promise.all([
      api.me.get(),
      api.study.today(),
      api.study.weeklyGoal(),
      api.study.recurringGoals(),
      api.calendar.todos(date),
      api.calendar.ddays(),
      api.calendar.holidays(2026),
      api.calendar.customHolidays(),
      api.calendar.shares(),
      api.timetable.get().then((x) => x.classes),
      api.timetable.shares(),
      api.social.friends(),
      api.social.received(),
      api.content.folders(),
      api.content.material(ids.material),
      api.quiz.sets(),
      api.quiz.flashcards(),
      api.rooms.mine(),
      api.shop.myItems(),
      api.shop.ledger(),
    ]),
  );
}
const writes: [string, () => Promise<unknown>][] = [
  ['me.update', () => api.me.update({ nickname: '오프라인 변경' })],
  ['me.setStatus', () => api.me.setStatus('busy')],
  ['me.changePlan', () => api.me.changePlan('pro')],
  [
    'study.addItem',
    () => api.study.addItem({ title: '실패할 항목', subjectName: '수학', goalMin: 30 }),
  ],
  ['study.startSession', () => api.study.startSession({ studyItemId: ids.item, mode: 'personal' })],
  ['study.pauseSession', () => api.study.pauseSession(ids.session)],
  ['study.resumeSession', () => api.study.resumeSession(ids.session)],
  ['study.setWeeklyGoal', () => api.study.setWeeklyGoal({ targetMin: 9999, notify80: true })],
  [
    'study.saveRecurringGoal',
    () => api.study.saveRecurringGoal({ _id: ids.goal, name: '실패할 수정' }),
  ],
  ['study.deleteRecurringGoal', () => api.study.deleteRecurringGoal(ids.goal)],
  [
    'calendar.addTodo',
    () =>
      api.calendar.addTodo({
        content: '실패할 추가',
        todoType: 'general',
        dueDate: date,
        timeSlot: 'none',
        subjectName: null,
      }),
  ],
  ['calendar.toggleTodo', () => api.calendar.toggleTodo(ids.todo, true)],
  ['calendar.addDday', () => api.calendar.addDday({ title: '실패할 디데이', date })],
  ['calendar.setHolidayHidden', () => api.calendar.setHolidayHidden('2026-12-25', true)],
  ['calendar.addCustomHoliday', () => api.calendar.addCustomHoliday({ name: '실패할 휴일', date })],
  ['calendar.removeCustomHoliday', () => api.calendar.removeCustomHoliday(ids.custom)],
  [
    'calendar.createShare',
    () => api.calendar.createShare({ rangeStart: date, rangeEnd: date, expiresInDays: 7 }),
  ],
  ['calendar.revokeShare', () => api.calendar.revokeShare(ids.share)],
  [
    'timetable.addClass',
    () =>
      api.timetable.addClass({
        subjectName: '실패할 수업',
        days: [2],
        startTime: '11:00',
        endTime: '12:00',
        location: '',
        color: '#abcdef',
      }),
  ],
  ['timetable.removeClass', () => api.timetable.removeClass(ids.lesson)],
  [
    'timetable.share',
    () => api.timetable.share({ friendIds: ['u-jiwoo', 'offline-new-friend'], mode: 'free_only' }),
  ],
  ['social.respond', () => api.social.respond(ids.request, true)],
  ['social.openDirect', () => api.social.openDirect('u-jiwoo')],
  [
    'content.createFolder',
    () => api.content.createFolder({ title: '실패할 폴더', subjectName: '수학' }),
  ],
  ['content.deleteFolder', () => api.content.deleteFolder(ids.folder)],
  [
    'content.createMaterial',
    () =>
      api.content.createMaterial({
        folderId: ids.folder,
        kind: 'handwriting',
        source: 'camera',
        title: '실패할 자료',
        blobUrls: [],
      }),
  ],
  ['content.saveMaterial', () => api.content.saveMaterial(ids.material)],
  [
    'content.updateSummary',
    () =>
      api.content.updateSummary(ids.material, [{ heading: '실패할 요약', body: '변경되면 안 됨' }]),
  ],
  ['content.deleteMaterial', () => api.content.deleteMaterial(ids.material)],
  ['content.addBookmark', () => api.content.addBookmark(ids.material, 99)],
  ['ai.cancel', () => api.ai.cancel(ids.job)],
  ['ai.retry', () => api.ai.retry(ids.job)],
  ['quiz.createSet', () => api.quiz.createSet(ids.material)],
  ['quiz.startAttempt', () => api.quiz.startAttempt('qs1')],
  ['quiz.answer', () => api.quiz.answer(ids.attempt, 'q1', 'A')],
  ['quiz.deleteFlashcards', () => api.quiz.deleteFlashcards([ids.card])],
  [
    'rooms.create',
    () => api.rooms.create({ title: '실패할 방', categoryName: '수학', isPublic: true }),
  ],
  ['rooms.join', () => api.rooms.join('ABCDEF')],
  ['rooms.leave', () => api.rooms.leave(ids.room)],
  ['rooms.setTimer', () => api.rooms.setTimer(ids.room, rule)],
  ['shop.wish', () => api.shop.wish(ids.shop)],
  ['shop.purchase', () => api.shop.purchase(ids.shop)],
  ['shop.equip', () => api.shop.equip('base')],
];

it.each(writes)('%s는 오프라인 실패 시 데이터를 변경하지 않는다', async (_name, write) => {
  const before = await snapshot();
  useNet.setState({ state: 'offline' });
  await expect(settle(write())).rejects.toBeInstanceOf(NetworkError);
  useNet.setState({ state: 'ok' });
  expect(await snapshot()).toEqual(before);
});

it.each(writes)('%s는 요청 대기 중 연결이 끊겨도 변경 전에 중단한다', async (_name, write) => {
  const before = await snapshot();
  const result = write();
  useNet.setState({ state: 'offline' });
  await expect(settle(result)).rejects.toBeInstanceOf(NetworkError);
  useNet.setState({ state: 'ok' });
  expect(await snapshot()).toEqual(before);
});
