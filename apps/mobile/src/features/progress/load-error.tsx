import { View } from 'react-native';
import { Text } from '@/components/text';
import { Btn } from '@/components/ui';

/** 조회 실패 안내. 빈 목록이나 0으로 보이지 않게 하고 다시 시도할 수 있게 한다 */
export const LoadError = ({ message, retry }: { message: string; retry: () => unknown }) => (
  <View className="my-2 gap-2">
    <Text className="text-caption text-sub">{message}</Text>
    <Btn small onPress={() => void retry()}>
      다시 시도
    </Btn>
  </View>
);
