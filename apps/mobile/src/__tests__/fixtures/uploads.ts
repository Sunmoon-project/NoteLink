// 실제 전송을 생략하는 목업 Blob 주소를 이 실행에서 고른 로컬 파일에 대응시킨다.
const sources = new Map<string, string>();
export function rememberMockUpload(blobUrl: string, uri: string) {
  sources.set(blobUrl, uri);
}
export function mockUploadSource(blobUrl: string) {
  return sources.get(blobUrl) ?? blobUrl;
}
