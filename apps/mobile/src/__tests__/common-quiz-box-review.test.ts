import { mockApi as api } from './fixtures/api';
import { useNet } from '../stores/net';
import { httpApi } from '../lib/api/http-api';
import { PATHS } from '@notelink/shared';
import { http, NetworkError } from '../lib/api/http';
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
beforeEach(() => {
  useNet.setState({ state: 'ok' });
});
it('보관함 저장은 중복 ID를 합치고 재조회에 보존하며 삭제 후 다시 저장할 수 있다', async () => {
  const [q] = await api.quiz.box();
  await api.quiz.deleteFromBox([q!._id]);
  expect((await api.quiz.box()).some((x) => x._id === q!._id)).toBe(false);
  await api.quiz.saveToBox([q!._id, q!._id]);
  await api.quiz.saveToBox([q!._id]);
  expect((await api.quiz.box()).filter((x) => x._id === q!._id)).toHaveLength(1);
});
it.each(['saveToBox', 'deleteFromBox'] as const)(
  '%s 오프라인 실패는 저장 목록을 바꾸지 않는다',
  async (method) => {
    const before = await api.quiz.box();
    useNet.setState({ state: 'offline' });
    await expect(api.quiz[method]([before[0]!._id])).rejects.toBeInstanceOf(NetworkError);
    useNet.setState({ state: 'ok' });
    expect(await api.quiz.box()).toEqual(before);
  },
);
it('없는 문제 ID가 섞이면 전체 요청을 거부하고 기존 보관함을 유지한다', async () => {
  const before = await api.quiz.box();
  await expect(api.quiz.saveToBox([before[0]!._id, 'missing-question'])).rejects.toThrow();
  expect(await api.quiz.box()).toEqual(before);
});

it('실서버 보관함 저장·삭제 요청에 선택한 문제 ID를 그대로 전달한다', async () => {
  const post = jest.spyOn(http, 'post').mockResolvedValueOnce([]).mockResolvedValueOnce(undefined);
  try {
    await httpApi.quiz.saveToBox(['q1', 'q2']);
    await httpApi.quiz.deleteFromBox(['q2']);
    expect(post).toHaveBeenNthCalledWith(1, PATHS.quizBox, { questionIds: ['q1', 'q2'] });
    expect(post).toHaveBeenNthCalledWith(2, `${PATHS.quizBox}/delete`, { questionIds: ['q2'] });
  } finally {
    post.mockRestore();
  }
});
