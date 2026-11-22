import { Image } from 'react-native';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { Box } from './frame-crop';
import type { LocalFile } from './upload';

export async function editPhoto(
  file: LocalFile,
  rotation: number,
  crop: boolean,
): Promise<LocalFile> {
  if (!rotation && !crop) return file;
  const { width, height } = await Image.getSize(file.uri);
  const context = ImageManipulator.manipulate(file.uri);
  // 미리보기와 동일한 중앙 85% 영역을 먼저 자르고 회전한다.
  if (crop)
    context.crop({
      originX: Math.floor(width * 0.075),
      originY: Math.floor(height * 0.075),
      width: Math.floor(width * 0.85),
      height: Math.floor(height * 0.85),
    });
  if (rotation) context.rotate(rotation);
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
  return {
    uri: result.uri,
    name: file.name.replace(/\.[^.]+$/, '') + '-edited.jpg',
    mimeType: 'image/jpeg',
    size: new File(result.uri).size,
  };
}

/** 사진에서 주어진 픽셀 영역만 잘라 JPEG로 저장한다 (카메라 틀 밖을 버릴 때) */
export async function cropPhoto(file: LocalFile, box: Box): Promise<LocalFile> {
  const context = ImageManipulator.manipulate(file.uri);
  context.crop({ originX: box.x, originY: box.y, width: box.width, height: box.height });
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
  return {
    uri: result.uri,
    name: file.name,
    mimeType: 'image/jpeg',
    size: new File(result.uri).size,
  };
}
