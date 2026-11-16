import { fireEvent, render, screen } from '@testing-library/react-native';
import { PageImages } from '../features/content/page-images';

const pages = [1, 2, 3].map((n) => ({ pageNo: n, imageUrl: `file:///p${n}.jpg`, sizeBytes: 0 }));
type Pages = Parameters<typeof PageImages>[0]['pages'];

it('위아래 스크롤은 모든 페이지를 이어서 보여 준다', async () => {
  await render(<PageImages pages={pages as Pages} mode="scroll" />);
  for (const n of [1, 2, 3]) expect(screen.getByLabelText(`${n}페이지 원본`)).toBeTruthy();
  expect(screen.queryByText('1 / 3')).toBeNull();
});

it('좌우 스와이프는 가로로 한 장씩 넘기고, 넘긴 뒤 몇 번째 장인지 보여 준다', async () => {
  await render(<PageImages pages={pages as Pages} mode="swipe" />);
  await fireEvent(screen.getByTestId('page-swipe'), 'layout', {
    nativeEvent: { layout: { width: 300, height: 400 } },
  });
  const scroller = screen.getByLabelText('원본 페이지, 좌우로 넘겨요');
  expect(scroller.props.horizontal).toBe(true);
  expect(scroller.props.pagingEnabled).toBe(true);
  expect(screen.getByText('1 / 3')).toBeTruthy();
  await fireEvent(scroller, 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: 600, y: 0 } },
  });
  expect(screen.getByText('3 / 3')).toBeTruthy();
});

it('탭해서 넘기기는 한 장만 보이고, 오른쪽을 누르면 다음 · 왼쪽은 앞 장', async () => {
  await render(<PageImages pages={pages as Pages} mode="tap" />);
  expect(screen.getByLabelText('1페이지 원본')).toBeTruthy();
  expect(screen.queryByLabelText('2페이지 원본')).toBeNull();
  const tap = (x: number) =>
    fireEvent.press(screen.getByRole('button'), { nativeEvent: { locationX: x } });
  // 너비를 모르면(0) 오른쪽으로 친다
  await tap(250);
  expect(screen.getByLabelText('2페이지 원본')).toBeTruthy();
  expect(screen.getByText('2 / 3')).toBeTruthy();
  await tap(250);
  await tap(250); // 마지막 장에서 멈춘다
  expect(screen.getByText('3 / 3')).toBeTruthy();
});
