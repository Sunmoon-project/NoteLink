import { queryClient } from '../lib/query';
import { NetworkError } from '../lib/api';
import { useToast } from '../stores/toast';
jest.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
afterEach(() => {
  queryClient.clear();
  useToast.setState({ msg: null });
  jest.useRealTimers();
});
it('미확정 네트워크 쓰기 실패를 자동으로 다시 전송하지 않는다', async () => {
  jest.useFakeTimers();
  const send = jest.fn().mockRejectedValue(new NetworkError('response lost'));
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: send });
  const result = mutation.execute(undefined).catch((error) => error);
  await jest.advanceTimersByTimeAsync(10000);
  await result;
  expect(send).toHaveBeenCalledTimes(1);
});
it('별도 오류 UI가 없는 저장 실패는 공통 안내를 제공한다', async () => {
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: async () => {
      throw new Error('offline');
    },
  });
  await expect(mutation.execute(undefined)).rejects.toThrow('offline');
  expect(useToast.getState().msg).toMatch(/못했어요/);
});
it('화면 자체 오류 안내가 있으면 공통 안내가 이를 덮어쓰지 않는다', async () => {
  const onError = jest.fn(() => useToast.getState().show('화면의 구체적 안내'));
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: async () => {
      throw new Error('offline');
    },
    onError,
  });
  await expect(mutation.execute(undefined)).rejects.toThrow('offline');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(useToast.getState().msg).toBe('화면의 구체적 안내');
});
it('정상 저장에는 오류 안내를 표시하지 않는다', async () => {
  const mutation = queryClient
    .getMutationCache()
    .build(queryClient, { mutationFn: async () => 'saved' });
  await expect(mutation.execute(undefined)).resolves.toBe('saved');
  expect(useToast.getState().msg).toBeNull();
});
