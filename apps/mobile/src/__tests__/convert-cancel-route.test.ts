import { pickedScreen } from '../features/content/convert';

jest.mock('expo-router', () => ({ router: {}, useLocalSearchParams: () => ({}) }));

// 실기기 피드백(2026-11-23): 문서를 스캔해 변환하다 취소하면 「선택한 파일」 화면이 떴다
it('문서 스캔을 취소하면 스캔 확인 화면으로 돌아간다', () => {
  expect(pickedScreen('document', 'scan')).toBe('/capture/scan-check');
  expect(pickedScreen('handwriting', 'scan')).toBe('/capture/scan-check');
  expect(pickedScreen('document', 'file')).toBe('/capture/picked-file');
  expect(pickedScreen('handwriting', 'camera')).toBe('/capture/picked');
});
