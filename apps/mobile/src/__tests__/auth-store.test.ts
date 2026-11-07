import type { User } from '@notelink/shared';
import { useAuth } from '../stores/auth';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const tokens = { accessToken: 'a', refreshToken: 'r' };
const user = (id: string) => ({ _id: id }) as User;

// 다른 계정으로 로그인하면 이전 계정의 온보딩 상태를 이어 가지 않는다
describe('auth mockStore', () => {
  beforeEach(async () => {
    mockStore.clear();
    useAuth.setState({ tokens: null, user: null, userId: null, onboarded: false });
  });

  it('같은 계정으로 다시 로그인하면 온보딩 완료를 유지한다', async () => {
    await useAuth.getState().signIn(tokens, user('u1'));
    await useAuth.getState().finishOnboarding();
    await useAuth.getState().load();
    await useAuth.getState().signIn(tokens, user('u1'));
    expect(useAuth.getState().onboarded).toBe(true);
  });

  it('로그아웃했다가 같은 계정으로 다시 로그인해도 초기 설정을 다시 하지 않는다', async () => {
    await useAuth.getState().signIn(tokens, user('u1'));
    await useAuth.getState().finishOnboarding();
    await useAuth.getState().signOut();
    await useAuth.getState().signIn(tokens, user('u2'));
    expect(useAuth.getState().onboarded).toBe(false);
    await useAuth.getState().signOut();
    // 앱을 다시 켠 뒤에도 기억한다
    await useAuth.getState().load();
    await useAuth.getState().signIn(tokens, user('u1'));
    expect(useAuth.getState().onboarded).toBe(true);
  });

  it('다른 계정으로 로그인하면 온보딩을 다시 한다', async () => {
    await useAuth.getState().signIn(tokens, user('u1'));
    await useAuth.getState().finishOnboarding();
    await useAuth.getState().load();
    expect(useAuth.getState().userId).toBe('u1');
    await useAuth.getState().signIn(tokens, user('u2'));
    expect(useAuth.getState().onboarded).toBe(false);
    expect(JSON.parse(mockStore.get('notelink.auth')!)).toMatchObject({
      userId: 'u2',
      onboarded: false,
    });
  });

  it('설정 완료를 저장하는 사이 다른 계정으로 로그인해도 그 계정은 설정을 마친 것으로 적지 않는다', async () => {
    await useAuth.getState().signIn(tokens, user('u1'));
    const finishing = useAuth.getState().finishOnboarding();
    await useAuth.getState().signIn(tokens, user('u2'));
    await finishing;
    await useAuth.getState().signOut();
    await useAuth.getState().signIn(tokens, user('u2'));
    expect(useAuth.getState().onboarded).toBe(false);
    await useAuth.getState().signOut();
    await useAuth.getState().signIn(tokens, user('u1'));
    expect(useAuth.getState().onboarded).toBe(true);
  });

  it('예전 형식(notelink.auth에만 완료 표시)으로 저장된 계정도 업데이트 뒤 다시 로그인하면 설정을 건너뛴다', async () => {
    mockStore.set('notelink.auth', JSON.stringify({ ...tokens, onboarded: true, userId: 'u1' }));
    await useAuth.getState().load();
    await useAuth.getState().signOut();
    await useAuth.getState().signIn(tokens, user('u1'));
    expect(useAuth.getState().onboarded).toBe(true);
  });
});
