import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// 화면 테스트: 앱 루트가 감싸는 Provider를 똑같이 감싼다
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

// 실패 응답을 다시 시도하지 않는다 (실제 앱은 재시도하지만 테스트가 몇 초씩 기다리지 않게)
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

export function renderScreen(ui: ReactElement, qc = testClient()) {
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}

declare global {
  var mockParams: Record<string, string | undefined>;
  /** useIsFocused가 돌려줄 값. 비우면 true */
  var mockFocused: boolean | undefined;
}
/** useLocalSearchParams가 돌려줄 값 (jest.setup.js의 expo-router 목) */
export const setParams = (p: Record<string, string | undefined>) => {
  globalThis.mockParams = p;
};
