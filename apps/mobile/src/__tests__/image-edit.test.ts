import { Image } from 'react-native';
import { editPhoto } from '../lib/image-edit';
const mockCrop = jest.fn();
const mockRotate = jest.fn();
const mockSave = jest.fn(async () => ({ uri: 'file://edited.jpg' }));
const mockRender = jest.fn(async () => ({ saveAsync: mockSave }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: {
    manipulate: jest.fn(() => ({ crop: mockCrop, rotate: mockRotate, renderAsync: mockRender })),
  },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-file-system', () => ({ File: jest.fn(() => ({ size: 123 })) }));
afterEach(() => jest.restoreAllMocks());
it('실제 픽셀 영역 자르기·회전 결과를 JPEG 파일로 저장한다', async () => {
  const original = Image.getSize;
  Image.getSize = jest.fn(async () => ({ width: 1000, height: 2000 }));
  try {
    expect(await editPhoto({ uri: 'file://original.png', name: 'original.png' }, 90, true)).toEqual(
      { uri: 'file://edited.jpg', name: 'original-edited.jpg', mimeType: 'image/jpeg', size: 123 },
    );
    expect(mockCrop).toHaveBeenCalledWith({ originX: 75, originY: 150, width: 850, height: 1700 });
    expect(mockRotate).toHaveBeenCalledWith(90);
    expect(mockRender).toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
  } finally {
    Image.getSize = original;
  }
});
it('보정이 없으면 원본 파일을 유지한다', async () => {
  const file = { uri: 'file://original.jpg', name: 'original.jpg' };
  expect(await editPhoto(file, 0, false)).toBe(file);
});
