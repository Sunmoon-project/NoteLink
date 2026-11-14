/** 접속 주소의 호스트가 이 PC 하나뿐인지 본다. 호스트를 여럿 적은 주소는 거부한다. */
export function isLocalMongoUri(uri: string | undefined): boolean {
  return !!uri && /^mongodb:\/\/([^@/,]*@)?(localhost|127\.0\.0\.1)(:\d+)?([/?]|$)/.test(uri);
}
