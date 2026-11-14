import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { UPLOAD_RULES } from '@notelink/shared';

const SAS_LIFETIME_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const REPORT_IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
};

@Injectable()
export class BlobStorageService {
  constructor(private readonly config: ConfigService) {}

  private async storage() {
    const raw = this.config.get<string>('AZURE_BLOB_ACCOUNT_URL')?.trim();
    const connectionString = this.config.get<string>('AZURE_STORAGE_CONNECTION_STRING')?.trim();
    const container = this.config.get<string>('AZURE_BLOB_CONTAINER')?.trim();
    let url: URL;
    let client: BlobServiceClient;
    try {
      url = new URL(raw ?? '');
      if (
        url.protocol !== 'https:' ||
        !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        url.port ||
        !connectionString ||
        !container ||
        !/^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(container)
      )
        throw new Error();
      client = BlobServiceClient.fromConnectionString(connectionString);
      if (
        !(client.credential instanceof StorageSharedKeyCredential) ||
        new URL(client.url).origin !== url.origin
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException({
        code: 'UPLOAD_UNAVAILABLE',
        message: '사진 저장소가 설정되지 않았어요.',
      });
    }
    return {
      container: container!,
      client,
      credential: client.credential as StorageSharedKeyCredential,
    };
  }

  async createUpload(blobName: string) {
    const { container, client, credential } = await this.storage();
    const now = Date.now();
    const startsOn = new Date(now - CLOCK_SKEW_MS);
    const expiresOn = new Date(now + SAS_LIFETIME_MS);
    try {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName,
          permissions: BlobSASPermissions.parse('c'),
          protocol: SASProtocol.Https,
          startsOn,
          expiresOn,
        },
        credential,
      ).toString();
      const blobUrl = client.getContainerClient(container).getBlockBlobClient(blobName).url;
      return {
        uploadUrl: `${blobUrl}?${sas}`,
        blobUrl,
        expiresAt: expiresOn.toISOString(),
        headers: { 'x-ms-blob-type': 'BlockBlob' },
      };
    } catch {
      throw new ServiceUnavailableException({
        code: 'UPLOAD_UNAVAILABLE',
        message: '사진 업로드를 준비하지 못했어요.',
      });
    }
  }

  async validateReportImages(userId: string, urls: string[]) {
    if (!urls.length) return;
    if (new Set(urls).size !== urls.length)
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '같은 사진을 중복해서 첨부할 수 없습니다.',
      });
    const { container, client } = await this.storage();
    for (const url of urls) {
      const containerClient = client.getContainerClient(container);
      const prefix = `${containerClient.url}/reports/${userId}/`;
      if (!url.startsWith(prefix))
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: '사용할 수 없는 신고 사진입니다.',
        });
      const fileName = url.slice(prefix.length);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|heic)$/.test(
          fileName,
        )
      )
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: '사용할 수 없는 신고 사진입니다.',
        });
      const blob = containerClient.getBlockBlobClient(`reports/${userId}/${fileName}`);
      if (blob.url !== url)
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: '사용할 수 없는 신고 사진입니다.',
        });
      try {
        const properties = await blob.getProperties();
        const extension = fileName.split('.').pop()!;
        if (
          !properties.contentLength ||
          properties.contentLength > UPLOAD_RULES.image.maxBytes ||
          properties.contentType !== REPORT_IMAGE_TYPES[extension]
        ) {
          throw new BadRequestException({
            code: 'BAD_REQUEST',
            message: '신고 사진의 크기 또는 형식이 올바르지 않습니다.',
          });
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        if (
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          error.statusCode === 404
        )
          throw new BadRequestException({
            code: 'BAD_REQUEST',
            message: '업로드한 신고 사진을 찾을 수 없습니다.',
          });
        throw new ServiceUnavailableException({
          code: 'UPLOAD_UNAVAILABLE',
          message: '신고 사진을 확인하지 못했어요.',
        });
      }
    }
  }
}
