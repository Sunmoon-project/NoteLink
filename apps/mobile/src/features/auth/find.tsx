import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { Text } from '@/components/text';
import { Btn, Canvas, Header, Input, Label, Screen, Segment } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { looksLikeEmail, passwordError } from '@/lib/validation';
import { toast } from '@/stores/toast';

const TABS = ['아이디 찾기', '비밀번호 찾기'] as const;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** 서버에 아직 경로가 없으면(404) 준비 중, 그 밖에는 서버가 준 문구 */
const failText = (e: unknown, fallback: string) =>
  e instanceof ApiError
    ? e.status === 404
      ? '아직 준비 중이에요. 문의하기로 알려 주세요.'
      : e.message
    : fallback;

/**
 * 로그인 화면의 「아이디 · 비밀번호 찾기」. 아이디는 가입 이메일이라, 아이디 찾기는 이메일 인증번호로
 * 그 이메일로 가입한 아이디가 있는지 확인한다. 비밀번호 찾기는 아이디와 이메일을 둘 다 받아 같은
 * 계정일 때 인증번호 뒤 새 비밀번호를 정한다.
 */
export function FindAccountScreen() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <Canvas cream>
      <Screen>
        <Header title="아이디 · 비밀번호 찾기" large={false} />
        <Segment items={TABS} value={tab} onChange={setTab} className="mt-2" />
        {tab === TABS[0] ? <FindId /> : <ResetPassword />}
      </Screen>
    </Canvas>
  );
}

/**
 * 이메일로 인증번호 보내기. 보낸 이메일을 기억해, 지금 칸의 이메일로 보낸 것이 성공했을 때만 「보냄」이다.
 * 보내는 중에 이메일을 바꾸면 앞 요청이 성공해도 다른 이메일의 인증번호 칸이 열리지 않는다(#343 리뷰)
 */
function useCode(email: string) {
  const [code, setCode] = useState('');
  const send = useMutation({
    mutationFn: (to: string) => api.auth.recoverySendCode(to),
    onSuccess: () => toast('인증번호를 보냈어요. 메일함을 확인해 주세요'),
  });
  const sent = send.isSuccess && send.variables === email.trim();
  return { code, setCode, send, sent, sendNow: () => send.mutate(email.trim()) };
}

function CodeField({ code, setCode }: { code: string; setCode: (v: string) => void }) {
  return (
    <>
      <Label>인증번호</Label>
      <Input
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        placeholder="6자리 숫자"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
      />
    </>
  );
}

function SendButton({
  sent,
  disabled,
  send,
  onPress,
}: {
  sent: boolean;
  disabled: boolean;
  send: ReturnType<typeof useCode>['send'];
  onPress: () => void;
}) {
  return (
    <>
      {send.isError && (
        <Text className="mt-2 text-footnote text-danger">
          {failText(send.error, '인증번호를 보내지 못했어요. 다시 시도해 주세요')}
        </Text>
      )}
      <Btn
        kind={sent ? 'cream' : undefined}
        className="mt-3"
        disabled={disabled}
        loading={send.isPending}
        onPress={onPress}
      >
        {sent ? '인증번호 다시 보내기' : '인증번호 보내기'}
      </Btn>
    </>
  );
}

function FindId() {
  const [email, setEmail] = useState('');
  const { code, setCode, send, sent, sendNow } = useCode(email);
  const find = useMutation({ mutationFn: () => api.auth.findId(email.trim(), code) });
  const found = find.data?.id;
  return (
    <View className="mt-4">
      <Text className="text-footnote leading-5 text-sub">
        가입할 때 쓴 이메일로 인증번호를 보내 드려요. 확인하면 그 이메일로 가입한 아이디를 알려
        드려요.
      </Text>
      <Label>이메일</Label>
      <Input
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          send.reset();
          find.reset();
        }}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        editable={!send.isPending}
      />
      <SendButton sent={sent} disabled={!looksLikeEmail(email)} send={send} onPress={sendNow} />
      {sent && (
        <>
          <CodeField code={code} setCode={setCode} />
          {find.isError && (
            <Text className="mt-3 text-footnote text-danger">
              {failText(find.error, '확인하지 못했어요. 다시 시도해 주세요')}
            </Text>
          )}
          {find.data &&
            (found ? (
              <View className="mt-4 gap-1 rounded-xl bg-white px-4 py-3">
                <Text className="text-caption text-sub">가입한 아이디</Text>
                <Text className="text-callout font-semibold text-ink">{found}</Text>
              </View>
            ) : (
              <Text className="mt-3 text-footnote text-danger">
                이 이메일로 가입한 계정이 없어요
              </Text>
            ))}
          <Btn
            className="mt-6"
            disabled={code.length !== 6}
            loading={find.isPending}
            onPress={() => find.mutate()}
          >
            아이디 찾기
          </Btn>
          {!!found && (
            <Btn
              kind="cream"
              className="mt-2"
              onPress={() =>
                router.replace({ pathname: '/(auth)/login', params: { email: found } })
              }
            >
              이 아이디로 로그인
            </Btn>
          )}
        </>
      )}
    </View>
  );
}

function ResetPassword() {
  const [id, setId] = useState('');
  const [email, setEmail] = useState('');
  const { code, setCode, send, sent, sendNow } = useCode(email);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const reset = useMutation({
    mutationFn: () => api.auth.passwordReset(id.trim(), email.trim(), code, pw),
    onSuccess: () => {
      toast('비밀번호를 바꿨어요. 새 비밀번호로 로그인해 주세요');
      router.replace({ pathname: '/(auth)/login', params: { email: id.trim() } });
    },
  });
  // 아이디는 가입 이메일이라, 두 칸이 같은 계정을 가리켜야 인증번호를 보낸다
  const mismatchIdEmail = !!id.trim() && looksLikeEmail(email) && !same(id, email);
  const pwMsg = pw ? passwordError(pw) : null;
  const mismatch = !!pw2 && pw !== pw2;
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    send.reset();
  };
  return (
    <View className="mt-4">
      <Text className="text-footnote leading-5 text-sub">
        아이디와 가입한 이메일을 둘 다 입력해 주세요. 같은 계정이면 이메일로 인증번호를 보내 드리고,
        확인하면 새 비밀번호를 정할 수 있어요.
      </Text>
      <Label>아이디</Label>
      <Input
        value={id}
        onChangeText={edit(setId)}
        placeholder="아이디(가입한 이메일)"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="username"
        editable={!reset.isPending && !send.isPending}
      />
      <Label>이메일</Label>
      <Input
        value={email}
        onChangeText={edit(setEmail)}
        invalid={mismatchIdEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        editable={!reset.isPending && !send.isPending}
      />
      {mismatchIdEmail && (
        <Text className="mt-1 text-caption text-danger">
          아이디와 이메일이 같은 계정이 아니에요. 가입할 때 쓴 이메일을 입력해 주세요
        </Text>
      )}
      <SendButton
        sent={sent}
        disabled={!id.trim() || !looksLikeEmail(email) || mismatchIdEmail}
        send={send}
        onPress={sendNow}
      />
      {sent && (
        <>
          <CodeField code={code} setCode={setCode} />
          <Label>새 비밀번호</Label>
          <Input
            value={pw}
            onChangeText={setPw}
            invalid={!!pwMsg}
            placeholder="8자 이상"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            maxLength={64}
          />
          {!!pwMsg && <Text className="mt-1 text-caption text-danger">{pwMsg}</Text>}
          <Label>새 비밀번호 확인</Label>
          <Input
            value={pw2}
            onChangeText={setPw2}
            invalid={mismatch}
            placeholder="한 번 더 입력해 주세요"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            maxLength={64}
          />
          {mismatch && (
            <Text className="mt-1 text-caption text-danger">비밀번호가 서로 달라요</Text>
          )}
          {reset.isError && (
            <Text className="mt-3 text-footnote text-danger">
              {failText(reset.error, '비밀번호를 바꾸지 못했어요. 다시 시도해 주세요')}
            </Text>
          )}
          <Btn
            className="mt-6"
            disabled={code.length !== 6 || !pw || !!pwMsg || pw !== pw2}
            loading={reset.isPending}
            onPress={() => reset.mutate()}
          >
            비밀번호 바꾸기
          </Btn>
        </>
      )}
    </View>
  );
}
