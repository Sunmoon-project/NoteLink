import { File } from 'expo-file-system';
import { checkFile, isMp4Container, uploadToBlob } from '../lib/upload';
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
const mockGetSas = jest.fn();
jest.mock('../lib/api', () => ({
  api: { upload: { getSas: (...a: unknown[]) => mockGetSas(...a) } },
}));
jest.mock('../lib/env', () => ({ env: { localData: false } }));
jest.mock('../lib/local/storage', () => ({ keepFile: jest.fn() }));

/** 앞 12바이트가 head인 파일. 올리기는 200으로 끝난다 */
function mockFile(head: number[] | Error) {
  const createUploadTask = jest.fn(() => ({ uploadAsync: async () => ({ status: 201 }) }));
  (File as unknown as jest.Mock).mockImplementation(() => ({
    size: 1024,
    open: () => {
      if (head instanceof Error) throw head;
      return { readBytes: () => new Uint8Array(head), close: jest.fn() };
    },
    createUploadTask,
  }));
  return createUploadTask;
}
// 'ftyp' 앞 4바이트는 상자 크기, 뒤는 'M4A '
const M4A_HEAD = [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20];
const ADTS_HEAD = [0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc, 0, 0, 0, 0, 0];

describe('녹음 실제 형식으로 올리기 (#508 후속: .aac 이름의 MP4가 Azure Speech에서 422)', () => {
  beforeEach(() => {
    mockGetSas.mockReset().mockResolvedValue({
      uploadUrl: 'https://blob/u?sas',
      blobUrl: 'https://blob/u',
      headers: { 'Content-Type': 'audio/mp4' },
    });
  });

  it('isMp4Container: ftyp 상자면 참, ADTS AAC · 짧은 값은 거짓', () => {
    expect(isMp4Container(new Uint8Array(M4A_HEAD))).toBe(true);
    expect(isMp4Container(new Uint8Array(ADTS_HEAD))).toBe(false);
    expect(isMp4Container(new Uint8Array([0, 0, 0]))).toBe(false);
  });

  it.each([
    ['녹음본.aac', 'audio/aac'],
    ['lecture.m4a.mp4', 'video/mp4'],
  ])('내용이 MP4인 %s 는 .m4a · audio/mp4로 주소를 받는다', async (name, mimeType) => {
    mockFile(M4A_HEAD);
    await uploadToBlob('audio', { uri: 'file:///a', name, mimeType, size: 1024 });
    expect(mockGetSas).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: name.replace(/\.[^.]+$/, '.m4a'),
        contentType: 'audio/mp4',
      }),
    );
  });

  it('진짜 ADTS AAC는 이름 · 형식을 그대로 둔다', async () => {
    mockFile(ADTS_HEAD);
    await uploadToBlob('audio', {
      uri: 'file:///a',
      name: 'raw.aac',
      mimeType: 'audio/aac',
      size: 1024,
    });
    expect(mockGetSas).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'raw.aac', contentType: 'audio/aac' }),
    );
  });

  it('앞부분을 읽지 못하면 원래 이름으로 올린다', async () => {
    mockFile(new Error('read failed'));
    await uploadToBlob('audio', {
      uri: 'file:///a',
      name: 'rec.aac',
      mimeType: 'audio/aac',
      size: 1024,
    });
    expect(mockGetSas).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'rec.aac' }));
  });

  it('사진은 내용을 읽지 않는다', async () => {
    mockFile(M4A_HEAD);
    mockGetSas.mockResolvedValue({ uploadUrl: 'u', blobUrl: 'b', headers: {} });
    await uploadToBlob('image', {
      uri: 'file:///a',
      name: 'p.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
    });
    expect(mockGetSas).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'p.jpg' }));
  });
});

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

  it('채팅 첨부는 사진 50MB · 파일 100MB까지 받는다(노트 상한보다 크게)', () => {
    const mb = 1024 * 1024;
    expect(checkFile('image', { uri: 'a', name: 'big.jpg', size: 30 * mb }, 'chat').ok).toBe(true);
    expect(checkFile('image', { uri: 'a', name: 'big.jpg', size: 51 * mb }, 'chat')).toEqual({
      ok: false,
      reason: '50MB 이하만 올릴 수 있어요',
    });
    expect(checkFile('document', { uri: 'a', name: 'a.pdf', size: 80 * mb }, 'chat').ok).toBe(true);
    expect(checkFile('document', { uri: 'a', name: 'a.pdf', size: 101 * mb }, 'chat')).toEqual({
      ok: false,
      reason: '100MB 이하만 올릴 수 있어요',
    });
    // 노트 · 신고는 그대로
    expect(checkFile('document', { uri: 'a', name: 'a.pdf', size: 80 * mb }).ok).toBe(false);
    expect(checkFile('image', { uri: 'a', name: 'big.jpg', size: 30 * mb }, 'report').ok).toBe(
      false,
    );
  });

  it('문서는 PDF를 허용하고 녹음 파일은 m4a를 허용한다', () => {
    expect(checkFile('document', { uri: 'a', name: '연습문제.pdf', size: 1024 }).ok).toBe(true);
    expect(checkFile('audio', { uri: 'a', name: 'lecture.m4a', size: 1024 }).ok).toBe(true);
    expect(checkFile('audio', { uri: 'a', name: 'lecture.exe', size: 1024 }).ok).toBe(false);
  });

  it.each(['녹음본.aac', 'lecture.m4a.mp4', 'REC.AAC'])('녹음 %s 도 허용한다 (#508)', (name) => {
    expect(checkFile('audio', { uri: 'a', name, size: 1024 }).ok).toBe(true);
  });
});
