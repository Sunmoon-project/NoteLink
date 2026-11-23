import { frameCropRect } from '../lib/frame-crop';

const preview = { width: 400, height: 800 }; // 1:2 화면
const frame = { x: 30, y: 100, width: 340, height: 453 };

describe('frameCropRect', () => {
  it('미리보기와 같은 비율의 세로 사진은 배율만 곱한다', () => {
    expect(frameCropRect(preview, frame, { width: 1200, height: 2400 })).toEqual({
      x: 90,
      y: 300,
      width: 1020,
      height: 1359,
    });
  });

  it('3:4 세로 사진은 좌우가 잘려 보이므로 그만큼 밀어서 환산한다', () => {
    // cover 배율 = 800/4000 = 0.2 → 보이는 폭 400/0.2 = 2000px, 양옆 500px씩 잘림
    expect(frameCropRect(preview, frame, { width: 3000, height: 4000 })).toEqual({
      x: 650,
      y: 500,
      width: 1700,
      height: 2265,
    });
  });

  it('가로로 보고된 센서 사진은 가로 · 세로를 바꿔 세로 사진처럼 환산한다', () => {
    expect(frameCropRect(preview, frame, { width: 2400, height: 1200 })).toEqual(
      frameCropRect(preview, frame, { width: 1200, height: 2400 }),
    );
  });

  it('사진 밖으로 나가지 않는다', () => {
    const r = frameCropRect(
      preview,
      { x: 0, y: 0, width: 400, height: 800 },
      { width: 3000, height: 4000 },
    );
    expect(r.x).toBe(500);
    expect(r.x + r.width).toBeLessThanOrEqual(3000);
    expect(r.y + r.height).toBeLessThanOrEqual(4000);
  });
});

// 실기기 값(2026-11-23 「스캔이 전체 화면으로 찍혀요」): iPhone 4032×3024 센서, EXIF orientation 6(세로로 들고 찍음)
describe('frameCropRect — iPhone 실측 크기', () => {
  // iPhone 16 Pro 화면 402×874, 틀 = w-[85%] aspect-[3/4], 위에서 약 150pt
  const phone = { width: 402, height: 874 };
  const box = { x: 30, y: 150, width: 342, height: 456 };

  it('expo-camera iOS가 미리보기 비율로 자른 세로 사진(1855×4032)에서 틀만 남긴다', () => {
    const r = frameCropRect(phone, box, { width: 1855, height: 4032 });
    expect(r.width).toBeLessThan(1855 * 0.9); // 전체 폭이 아니다
    expect(r.height).toBeLessThan(4032 * 0.6); // 전체 높이가 아니다
    expect(r.x + r.width).toBeLessThanOrEqual(1855);
    expect(r.y + r.height).toBeLessThanOrEqual(4032);
    expect(r.width / r.height).toBeCloseTo(3 / 4, 2);
  });

  it('센서 방향(4032×3024, EXIF 6 회전 전)으로 보고돼도 회전 뒤 세로 사진 기준 영역을 준다', () => {
    const r = frameCropRect(phone, box, { width: 4032, height: 3024 });
    expect(r).toEqual(frameCropRect(phone, box, { width: 3024, height: 4032 }));
    expect(r.x + r.width).toBeLessThanOrEqual(3024);
    expect(r.y + r.height).toBeLessThanOrEqual(4032);
    expect(r.width / r.height).toBeCloseTo(3 / 4, 2);
  });
});
