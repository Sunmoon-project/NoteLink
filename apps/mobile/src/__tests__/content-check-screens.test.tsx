import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { PickedFileScreen, RecUploadScreen } from '../features/content/capture';
import { useDraft } from '../stores/draft';
import { renderScreen } from '../test-utils';

jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(async () => {}),
  useAudioRecorder: () => ({}),
  useAudioRecorderState: () => ({ durationMillis: 0, isRecording: false }),
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));

beforeEach(() => {
  jest.clearAllMocks();
  useDraft.getState().reset();
});

describe('올린 자료 내용 검사', () => {
  it('아주 작은 녹음 파일 · PDF는 적절하지 않다고 알리고 다른 파일을 고르게 한다', async () => {
    useDraft.getState().set({
      kind: 'recording',
      files: [
        { uri: 'file:///short.m4a', name: 'short.m4a', mimeType: 'audio/mp4', size: 12 * 1024 },
      ],
    });
    await renderScreen(<RecUploadScreen />);
    expect(screen.getByText(/너무 짧아/)).toBeTruthy();
    await fireEvent.press(screen.getByText('다음'));
    expect(await screen.findByText('정리하기에 적절하지 않은 녹음이에요')).toBeTruthy();
    await fireEvent.press(screen.getByText('다른 파일 고르기'));
    expect(useDraft.getState().files).toEqual([]);
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  // 허용 목록(UPLOAD_RULES.audio)에 들어갈 일이 없는 형식으로 본다. 안내 문구는 허용 목록으로 만들어지므로 끝만 맞춘다
  it.each([
    ['voice.ogg', 'audio/ogg', 21 * 1024 * 1024],
    ['call.amr', 'audio/amr', 16 * 1024 * 1024],
  ])(
    '올릴 수 없는 확장자(%s)는 고를 때 이유를 보여 주고 다음으로 넘어가지 않는다 (#508)',
    async (name, mimeType, size) => {
      useDraft.getState().set({
        kind: 'recording',
        files: [{ uri: `file:///${name}`, name, mimeType, size }],
      });
      await renderScreen(<RecUploadScreen />);
      expect(screen.getByText(/^MP3 · M4A .*만 올릴 수 있어요$/)).toBeTruthy();
      expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
      await fireEvent.press(screen.getByText('다음'));
      expect(router.replace).not.toHaveBeenCalledWith('/convert');
    },
  );
  it('허용된 녹음(m4a)은 그대로 다음으로 넘어간다', async () => {
    useDraft.getState().set({
      kind: 'recording',
      files: [
        {
          uri: 'file:///ok.m4a',
          name: 'ok.m4a',
          mimeType: 'audio/mp4a-latm',
          size: 5 * 1024 * 1024,
        },
      ],
    });
    await renderScreen(<RecUploadScreen />);
    expect(screen.queryByText(/만 올릴 수 있어요/)).toBeNull();
    await fireEvent.press(screen.getByText('다음'));
    expect(router.replace).toHaveBeenCalledWith('/convert');
  });
  it('빈 페이지 수준의 PDF도 알린다', async () => {
    useDraft.getState().set({
      kind: 'document',
      files: [
        {
          uri: 'file:///blank.pdf',
          name: 'blank.pdf',
          mimeType: 'application/pdf',
          size: 3 * 1024,
        },
      ],
    });
    await renderScreen(<PickedFileScreen />);
    expect(screen.getByText(/내용이 거의 없는 문서/)).toBeTruthy();
    await fireEvent.press(screen.getByText('다음'));
    expect(await screen.findByText('정리하기에 적절하지 않은 문서예요')).toBeTruthy();
  });
  it('경고를 배경 · 뒤로가기로 닫으면 올리지 않고 그 자리에 남는다', async () => {
    useDraft.getState().set({
      kind: 'recording',
      files: [
        { uri: 'file:///short.m4a', name: 'short.m4a', mimeType: 'audio/mp4', size: 12 * 1024 },
      ],
    });
    await renderScreen(<RecUploadScreen />);
    await fireEvent.press(screen.getByText('다음'));
    await screen.findByText('정리하기에 적절하지 않은 녹음이에요');
    // 배경 터치 (Android 뒤로가기도 같은 onClose)
    await fireEvent.press(screen.getByLabelText('대화상자 닫기', { includeHiddenElements: true }));
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
    expect(useDraft.getState().files).toHaveLength(1);
  });
});
