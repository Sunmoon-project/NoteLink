import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { Text } from '@/components/text';
import { Btn, Canvas, Header, Input, Label, Screen, Segment } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { looksLikeEmail, passwordError } from '@/lib/validation';
import { toast } from '@/stores/toast';

const TABS = ['아이디 찾기', '비밀번호 재설정'] as const;

/** 서버에 아직 경로가 없으면(404) 준비 중, 그 밖에는 서버가 준 문구 */
const failText = (e: unknown, fallback: string) =>
  e instanceof ApiError
    ? e.status === 404
      ? '아직 준비 중이에요. 문의하기로 알려 주세요.'
      : e.message
    : fallback;

/** 로그인 화면의 「아이디 · 비밀번호 찾기」. 아이디는 가입 이메일이라 닉네임으로 찾고, 비밀번호는 메일 인증 뒤 새로 정한다 */
export function FindAccountScreen() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <Canvas cream>
      <Screen>
        <Header title="아이디 · 비밀번호 찾기" large={false} />
        <Segment items={TABS} value={tab} onChange={setTab} className="mt-2" />
        {tab === TABS[0] ? <FindEmail /> : <ResetPassword />}
      </Screen>
    </Canvas>
  );
}

function FindEmail() {
  const [nickname, setNickname] = useState('');
  const find = useMutation({ mutationFn: () => api.auth.findEmail(nickname.trim()) });
  return (
    <View className="mt-4">
      <Text className="text-footnote leading-5 text-sub">
        노트링크 아이디는 가입한 이메일이에요. 닉네임을 입력하면 가입한 이메일을 일부 가려서 알려
        드려요.
      </Text>
      <Label>닉네임</Label>
      <Input
        value={nickname}
        onChangeText={(v) => {
          setNickname(v);
          find.reset();
        }}
        placeholder="가입할 때 정한 닉네임"
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={() => nickname.trim() && find.mutate()}
      />
      {find.isError && (
        <Text className="mt-3 text-footnote text-danger">
          {failText(find.error, '찾지 못했어요. 다시 시도해 주세요')}
        </Text>
      )}
      {find.data &&
        (find.data.emails.length ? (
          <View className="mt-4 gap-1 rounded-xl bg-white px-4 py-3">
            <Text className="text-caption text-sub">가입한 이메일</Text>
            {find.data.emails.map((e) => (
              <Text key={e} className="text-callout font-semibold text-ink">
                {e}
              </Text>
            ))}
          </View>
        ) : (
          <Text className="mt-3 text-footnote text-danger">이 닉네임으로 가입한 계정이 없어요</Text>
        ))}
      <Btn
        className="mt-6"
        disabled={!nickname.trim()}
        loading={find.isPending}
        onPress={() => find.mutate()}
      >
        아이디 찾기
      </Btn>
      {!!find.data?.emails.length && (
        <Btn kind="cream" className="mt-2" onPress={() => router.back()}>
          로그인하러 가기
        </Btn>
      )}
    </View>
  );
}

function ResetPassword() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const send = useMutation({
    mutationFn: () => api.auth.passwordSendCode(email.trim()),
    onSuccess: () => toast('인증번호를 보냈어요. 메일함을 확인해 주세요'),
  });
  const reset = useMutation({
    mutationFn: () => api.auth.passwordReset(email.trim(), code, pw),
    onSuccess: () => {
      toast('비밀번호를 바꿨어요. 새 비밀번호로 로그인해 주세요');
      router.replace({ pathname: '/(auth)/login', params: { email: email.trim() } });
    },
  });
  const sent = send.isSuccess;
  const pwMsg = pw ? passwordError(pw) : null;
  const mismatch = !!pw2 && pw !== pw2;
  return (
    <View className="mt-4">
      <Text className="text-footnote leading-5 text-sub">
        가입한 이메일로 인증번호를 보내 드려요. 확인하면 새 비밀번호를 정할 수 있어요.
      </Text>
      <Label>이메일</Label>
      <Input
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          if (sent) send.reset();
        }}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        editable={!reset.isPending}
      />
      {send.isError && (
        <Text className="mt-2 text-footnote text-danger">
          {failText(send.error, '인증번호를 보내지 못했어요. 다시 시도해 주세요')}
        </Text>
      )}
      <Btn
        kind={sent ? 'cream' : undefined}
        className="mt-3"
        disabled={!looksLikeEmail(email)}
        loading={send.isPending}
        onPress={() => send.mutate()}
      >
        {sent ? '인증번호 다시 보내기' : '인증번호 보내기'}
      </Btn>
      {sent && (
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
