import { audioFileIssue, documentIssue, recordingIssue } from '../lib/content-check';

it('실시간 녹음: 30초 미만이거나 소리가 거의 없으면 알린다', () => {
  expect(recordingIssue(12, 0.8)).toMatch(/짧아/);
  expect(recordingIssue(600, 0.05)).toMatch(/소리가 거의/);
  expect(recordingIssue(600, 0.6)).toBeNull();
});

it('올린 녹음 · 문서: 내용이 담기기 어려운 크기면 알린다', () => {
  expect(audioFileIssue(20 * 1024)).toMatch(/짧아/);
  expect(audioFileIssue(3 * 1024 * 1024)).toBeNull();
  expect(audioFileIssue(undefined)).toBeNull();
  expect(documentIssue({ name: '빈 문서.pdf', size: 4 * 1024 })).toMatch(/내용이 거의 없는 문서/);
  expect(documentIssue({ name: '안내서.pdf', size: 800 * 1024 })).toBeNull();
  expect(documentIssue({ name: 'scan.jpg', size: 10 * 1024 })).toMatch(/이미지/);
});
