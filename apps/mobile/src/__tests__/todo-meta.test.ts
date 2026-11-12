import type { Todo } from '@notelink/shared';
import { todoMeta } from '../features/calendar/todo';

const todo = (p: Partial<Todo>) =>
  ({ todoType: 'general', subjectName: null, timeSlot: 'none', dueTime: null, ...p }) as Todo;

it('날짜 시트 할 일 줄은 종류를 먼저 쓰고, 과목이 없으면 비워 둔다', () => {
  expect(todoMeta(todo({ todoType: 'assignment' }))).toBe('과제 · 시간 미정');
  expect(todoMeta(todo({ todoType: 'exam', subjectName: '수학', timeSlot: 'pm' }))).toBe(
    '시험 · 수학 · 오후',
  );
  expect(todoMeta(todo({}))).toBe('일반 · 시간 미정');
});
