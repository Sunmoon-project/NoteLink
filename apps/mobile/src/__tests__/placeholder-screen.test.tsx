import { fireEvent, render, screen } from '@testing-library/react-native';
import { router, useSitemap, type SitemapType } from 'expo-router';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';

const friendsRoute: SitemapType = {
  contextKey: './friends.tsx',
  filename: 'friends.tsx',
  href: '/friends',
  isInitial: false,
  isInternal: false,
  isGenerated: false,
  children: [],
};

afterEach(() => {
  jest.mocked(useSitemap).mockReturnValue(null);
  jest.clearAllMocks();
});

describe('PlaceholderScreen', () => {
  it('제목을 보여 준다', async () => {
    await render(<PlaceholderScreen title="퀴즈" />);
    expect(screen.getByText('퀴즈')).toBeTruthy();
  });

  it('홈이 아직 자리 표시 화면이어도 등록된 친구·채팅으로 들어갈 수 있다', async () => {
    jest.mocked(useSitemap).mockReturnValue(friendsRoute);
    await render(<PlaceholderScreen title="홈" />);
    await fireEvent.press(screen.getByText('친구 · 채팅'));
    expect(router.push).toHaveBeenCalledWith('/friends');
  });

  it('친구 기능이 등록되지 않았으면 진입 버튼을 표시하지 않는다', async () => {
    jest.mocked(useSitemap).mockReturnValue(null);
    await render(<PlaceholderScreen title="홈" />);
    expect(screen.queryByText('친구 · 채팅')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});
