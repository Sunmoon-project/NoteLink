import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { showBanner } from './notification-route';

// FCM · APNs 푸시 (p.16: 메인 API가 푸시 발송). 기기 토큰을 서버에 등록한다.

Notifications.setNotificationHandler({
  handleNotification: async ({ request }) => {
    const isRoomTimer = request.content.data?.type === 'study-room-timer';
    // 지금 보고 있는 채팅방의 새 메시지는 띄우지 않는다(화면에 이미 보인다)
    const show = showBanner(request.content.data);
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: isRoomTimer,
      shouldSetBadge: false,
    };
  },
});

export async function registerPush() {
  if (!Device.isDevice) return; // 시뮬레이터는 푸시 토큰이 없다
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('study-room-timer', {
      name: '스터디룸 타이머',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof projectId !== 'string') return;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api.me.registerDevice({
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    pushToken: String(data),
    locale: 'ko-KR',
  });
}

/** 로컬 알림 (변환 완료 · 반복 목표 리마인드) */
export function notifyLocal(title: string, body: string) {
  return Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}
