import { View } from 'react-native';
import { Text } from '@/components/text';
import { useQueryClient } from '@tanstack/react-query';
import { mockDemo } from '@/lib/mock/api';
import { useMockFlags, type MockFlags } from '@/lib/mock/flags';
import { useNet, type NetState } from '@/stores/net';
import { toast } from '@/stores/toast';
import { Btn, Chip, Group, Header, Label, Row, Screen, Toggle } from '@/components/ui';

// 목업 모드 전용 — 발표 자료 p.96~102 예외 처리를 실제 화면 위에서 재현하는 스위치

const FLAGS: [keyof MockFlags, string, string][] = [
  ['uploadPause', '업로드 중 연결 끊김', 'p.98 · 노트 올리기에서 확인'],
  ['llmSlow', 'LLM 일시 오류 (재시도)', 'p.99 · AI 변환 중 자동 재시도 2/3'],
  ['llmFail', 'LLM 재시도 실패', 'p.99 · 정리 실패 · 원본만 저장'],
  ['aiCreditExhausted', 'AI 크레딧 소진', 'p.98 · 퀴즈 만들기에서 확인'],
  ['tokenExpired', '로그인 만료', 'p.101 · 퀴즈 풀이에서 확인'],
  ['purchaseFail', '구매 중 연결 끊김', 'p.101 · 상점 구매에서 확인'],
  ['roomDisconnect', '스터디룸 연결 끊김 → 재연결', 'p.100 · 스터디룸 화면에서 확인'],
  ['roomKick', '스터디룸 5분 끊김 → 자동 퇴장', 'p.100 · 스터디룸 화면에서 확인'],
];
const NET: [NetState, string][] = [
  ['ok', '정상'],
  ['unstable', '연결 불안정'],
  ['offline', '오프라인'],
  ['maintenance', '서버 점검'],
  ['aiMaintenance', 'AI 점검'],
];

export function DevScreen() {
  const flags = useMockFlags();
  const net = useNet();
  const qc = useQueryClient();
  return (
    <Screen>
      <Header
        title="예외 시나리오"
        sub="목업 모드에서만 보여요. 실서버에서는 실제 오류 응답으로 같은 화면이 떠요."
      />
      <Label>연결 상태 (p.97 · p.99 · p.101 배너)</Label>
      <View className="flex-row flex-wrap gap-2">
        {NET.map(([k, l]) => (
          <Chip key={k} small on={net.state === k} onPress={() => net.set(k)}>
            {l}
          </Chip>
        ))}
      </View>
      <Label>서버 · AI 오류</Label>
      <Group>
        {FLAGS.map(([k, l, sub]) => (
          <Row
            key={k}
            sub={sub}
            right={<Toggle label={l} on={flags[k]} onChange={() => flags.toggle(k)} />}
          >
            {l}
          </Row>
        ))}
      </Group>
      <Label>데모 데이터</Label>
      <Btn
        kind="outline"
        onPress={() => {
          mockDemo.seedStudyItems();
          mockDemo.seedFolder();
          qc.invalidateQueries();
          toast('발표 자료 화면과 같은 데이터를 채웠어요');
        }}
      >
        발표 자료 데이터 채우기
      </Btn>
      <Btn
        kind="ghost"
        className="mt-2"
        onPress={() => {
          flags.reset();
          net.set('ok');
          toast('모든 시나리오를 껐어요');
        }}
      >
        모두 끄기
      </Btn>
      <Text className="mt-4 text-caption leading-5 text-sub">
        이미지 검사(p.102)는 갤러리에서 고른 사진의 형식 · 용량을 기기에서 먼저 확인하고, 파일
        이름에 ‘풍경’이나 ‘단어장’이 들어간 사진은 목업 AI가 필기 아님 · 읽기 어려움으로 판별해요.
      </Text>
    </Screen>
  );
}
