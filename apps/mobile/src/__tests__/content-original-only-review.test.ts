import { waitFor } from '@testing-library/react-native';
import { api } from '../lib/api';
import { useMockFlags } from '../lib/mock/flags';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => useMockFlags.getState().reset());
it('AI 정리가 실패해도 원본만 저장하면 폴더 목록에서 다시 찾을 수 있다', async () => {
  useMockFlags.setState({ llmFail: true });
  const folderId = 'folder-original-only-review';
  const { material, job } = await api.content.createMaterial({
    folderId,
    kind: 'document',
    source: 'file',
    title: '실패 후 원본.pdf',
    blobUrls: ['https://blob.example/original-to-keep.pdf'],
  });
  try {
    await waitFor(async () => expect((await api.ai.job(job._id)).status).toBe('failed'), {
      timeout: 6000,
    });
    await api.content.saveMaterial(material._id);
    const listed = await api.content.materials(folderId);
    expect(listed.map((item) => item._id)).toContain(material._id);
    const saved = listed.find((item) => item._id === material._id);
    expect(saved?.title).toBe('실패 후 원본.pdf');
    expect(saved?.processing.status).toBe('failed');
  } finally {
    await api.ai.cancel(job._id);
  }
}, 10000);
