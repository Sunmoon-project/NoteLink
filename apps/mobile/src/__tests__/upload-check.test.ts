import { checkFile } from '../lib/upload';
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
jest.mock('../lib/api', () => ({ api: {} }));

// p.102 — 형식 · 용량은 올리기 전에 기기에서 먼저 확인한다
describe('checkFile', () => {
  it('허용된 이미지 형식과 20MB 이하는 통과', () => {
    expect(checkFile('image', { uri: 'a', name: 'note.HEIC', size: 3 * 1024 * 1024 })).toEqual({
      ok: true,
    });
  });

  it('BMP는 형식 때문에 막는다', () => {
    const r = checkFile('image', { uri: 'a', name: '스캔본.bmp', size: 1024 });
    expect(r.ok).toBe(false);
  });

  it('20MB를 넘으면 막는다', () => {
    const r = checkFile('image', { uri: 'a', name: 'big.jpg', size: 24 * 1024 * 1024 });
    expect(r).toEqual({ ok: false, reason: '20MB 이하만 올릴 수 있어요' });
  });

  it('문서는 PDF를 허용하고 녹음 파일은 m4a를 허용한다', () => {
    expect(checkFile('document', { uri: 'a', name: '연습문제.pdf', size: 1024 }).ok).toBe(true);
    expect(checkFile('audio', { uri: 'a', name: 'lecture.m4a', size: 1024 }).ok).toBe(true);
    expect(checkFile('audio', { uri: 'a', name: 'lecture.exe', size: 1024 }).ok).toBe(false);
  });
});
