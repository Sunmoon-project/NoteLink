import { loadEnvFile } from 'node:process';
import { BlobServiceClient } from '@azure/storage-blob';
import { beforeAll, describe, expect, it } from 'vitest';

// 명시적으로 실행할 때만 실제 Azure를 읽는다. 비밀값과 SAS는 출력하지 않는다.
describe.skipIf(process.env.AZURE_BLOB_INTEGRATION !== '1')(
  '실제 Azure 신고 사진 저장소 연결',
  () => {
    let connectionString: string | undefined;

    beforeAll(() => {
      loadEnvFile('.env');
    });

    it('서버 환경변수에서 연결 문자열을 읽는다', () => {
      connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      expect(Boolean(connectionString), 'AZURE_STORAGE_CONNECTION_STRING 설정이 필요합니다').toBe(
        true,
      );
    });

    it('연결 문자열의 Blob 계정과 설정된 컨테이너에 접근한다', async () => {
      if (!connectionString) throw new Error('서버 연결 문자열을 먼저 설정해야 합니다');
      const accountUrl = process.env.AZURE_BLOB_ACCOUNT_URL;
      const containerName = process.env.AZURE_BLOB_CONTAINER;
      expect(Boolean(accountUrl), 'AZURE_BLOB_ACCOUNT_URL 설정이 필요합니다').toBe(true);
      expect(Boolean(containerName), 'AZURE_BLOB_CONTAINER 설정이 필요합니다').toBe(true);
      let client: BlobServiceClient;
      try {
        client = BlobServiceClient.fromConnectionString(connectionString);
      } catch {
        throw new Error('서버 연결 문자열을 Blob 연결에 사용할 수 없습니다');
      }
      expect(new URL(client.url).origin).toBe(new URL(accountUrl!).origin);
      try {
        await client.getContainerClient(containerName!).getProperties();
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'statusCode' in error
            ? String(error.statusCode)
            : '확인 불가';
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Blob 컨테이너 확인 실패 (HTTP ${status})`);
      }
    }, 30000);
  },
);
