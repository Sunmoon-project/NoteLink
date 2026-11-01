import { render, screen } from '@testing-library/react-native';
import { Avatar } from '../components/ui';

const mockSvgXml = jest.fn<null, [unknown]>(() => null);
jest.mock('react-native-svg', () => ({
  ...jest.requireActual('react-native-svg'),
  SvgXml: (props: unknown) => mockSvgXml(props),
}));
afterEach(() => {
  jest.clearAllMocks();
});

it('저장된 SVG 데이터 URI는 디코딩한 XML을 SVG 렌더러에 전달한다', async () => {
  const xml =
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><desc>학습 아바타</desc><rect width="128" height="128" fill="#8cbea3"/></svg>';
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await render(<Avatar name="가" uri={uri} size={64} />);
  expect(mockSvgXml).toHaveBeenCalledWith(expect.objectContaining({ xml, width: 64, height: 64 }));
  // SVG의 접근성 이름은 유지하면서 React Native Image에는 지원하지 않는 URI를 넘기지 않는다.
  expect(screen.getByLabelText('프로필 사진').props.source).toBeUndefined();
});

it.each(['https://example.test/avatar.png', 'data:image/png;base64,iVBORw0KGgo='])(
  '지원되는 일반 이미지 %s는 기존 Image 소스로 유지한다',
  async (uri) => {
    await render(<Avatar name="가" uri={uri} />);
    expect(screen.getByLabelText('프로필 사진').props.source.uri).toBe(uri);
    expect(mockSvgXml).not.toHaveBeenCalled();
  },
);

it('잘못 인코딩된 SVG 데이터는 예외 없이 이름 대체 표시로 복구한다', async () => {
  await render(<Avatar name="가" uri="data:image/svg+xml;charset=utf-8,%E0%A4%A" />);
  expect(screen.getByText('가')).toBeTruthy();
  expect(mockSvgXml).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('프로필 사진')).toBeNull();
});
