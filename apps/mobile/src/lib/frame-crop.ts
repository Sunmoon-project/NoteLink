export type Box = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/**
 * 카메라 미리보기(cover로 화면을 채움) 위의 틀 영역을 찍힌 사진의 픽셀 영역으로 환산한다.
 * - preview: 미리보기 크기, frame: 미리보기 안 틀의 위치·크기(onLayout), photo: takePictureAsync가 준 크기
 * - 사진이 가로(센서 방향)인데 미리보기는 세로(또는 반대)면 EXIF 회전 뒤 모습에 맞춰 가로·세로를 바꿔 본다.
 */
export function frameCropRect(preview: Size, frame: Box, photo: Size): Box {
  const upright =
    photo.width > photo.height === preview.width > preview.height
      ? photo
      : { width: photo.height, height: photo.width };
  const s = Math.max(preview.width / upright.width, preview.height / upright.height);
  const offX = (upright.width * s - preview.width) / 2;
  const offY = (upright.height * s - preview.height) / 2;
  const x = Math.max(0, Math.round((frame.x + offX) / s));
  const y = Math.max(0, Math.round((frame.y + offY) / s));
  return {
    x,
    y,
    width: Math.min(upright.width - x, Math.round(frame.width / s)),
    height: Math.min(upright.height - y, Math.round(frame.height / s)),
  };
}
