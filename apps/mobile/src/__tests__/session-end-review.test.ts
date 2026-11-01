import { useSession } from '../stores/session';
import { api } from '../lib/api';
jest.mock('../lib/api', () => ({ api: { study: { endSession: jest.fn() } } }));
afterEach(() => {
  useSession.getState().reset();
  jest.resetAllMocks();
});
it('종료 요청 실패 후 세션을 보존하고 같은 ID로 다시 종료한다', async () => {
  useSession.setState({ itemId: 'item', sessionId: 'retry', since: Date.now() - 5000 });
  jest
    .mocked(api.study.endSession)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ durationSec: 5, pointsEarned: 1 });
  await expect(useSession.getState().end('manual')).rejects.toThrow('offline');
  expect(useSession.getState().sessionId).toBe('retry');
  await expect(useSession.getState().end('manual')).resolves.toEqual({ sec: 5, pointsEarned: 1 });
  expect(useSession.getState().sessionId).toBeNull();
});
it('지연된 종료 응답이 계정 전환 후 새 세션을 초기화하지 않는다', async () => {
  let resolve!: (v: { durationSec: number; pointsEarned: number }) => void;
  jest.mocked(api.study.endSession).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  useSession.setState({ itemId: 'old', sessionId: 'old', since: Date.now() - 5000 });
  const first = useSession.getState().end('manual');
  const duplicate = useSession.getState().end('manual');
  expect(api.study.endSession).toHaveBeenCalledTimes(1);
  useSession.getState().reset();
  useSession.setState({ itemId: 'new', sessionId: 'new', since: Date.now() });
  resolve({ durationSec: 5, pointsEarned: 1 });
  await Promise.all([first, duplicate]);
  expect(useSession.getState().sessionId).toBe('new');
});
