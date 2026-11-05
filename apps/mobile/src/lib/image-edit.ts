import { Image } from 'react-native';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
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
