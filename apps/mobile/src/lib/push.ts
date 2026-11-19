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

/** 이 기기 토큰을 서버에 등록했는지. 등록했으면 작업 완료 알림은 서버 푸시가 보내므로 로컬 알림을 띄우지 않는다 */
let registered = false;
export const pushRegistered = () => registered;
/** 로그아웃 · 계정 전환: 다음 계정은 등록에 성공해야 서버 푸시로 본다 */
export const forgetPushRegistration = () => {
  registered = false;
};

export async function registerPush() {
  // 새 토큰(로그인 · 계정 전환)마다 다시 판단한다: 이번 등록이 실패하면 이전 계정의 성공을 믿지 않는다
  registered = false;
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
  registered = true;
}

/** 로컬 알림 (변환 완료 · 반복 목표 리마인드) */
export function notifyLocal(title: string, body: string) {
  return Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
}
