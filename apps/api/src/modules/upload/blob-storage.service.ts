import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import { ERROR_CODES, UPLOAD_RULES } from '@notelink/shared';

/** 앱이 올린 파일 이름: uuid(v4).확장자 (UploadsService.issue 가 randomUUID 로 만든다) */
const UPLOADED_FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;
const SAS_LIFETIME_MS = 10 * 60 * 1000;
const IMAGE_CHECK_SAS_LIFETIME_MS = 15 * 60 * 1000;
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

  /**
   * 올린 파일 하나를 읽기만 할 수 있는 SAS 주소로 만든다(기존 createUpload 와 별개).
   * 설정한 컨테이너 안의 파일 주소가 아니면 거절한다. verify 를 주면 주소가 prefix 아래의
   * `<uuid>.<확장자>` 꼴인지 보고, 실제로 있는 파일인지 확인해 크기(sizeBytes)도 돌려준다
   * (노트 등록). 없으면 저장된 주소를 서명만 한다(응답에 이미지를 담을 때).
   * 오류 메시지 · 로그에는 주소와 SAS 를 넣지 않는다.
   */
  async createReadAccess(
    blobUrl: string,
    ttlMs: number,
    verify?: { prefix: string },
  ): Promise<{ readUrl: string; sizeBytes?: number }> {
    const { container, client, credential } = await this.storage();
    const containerClient = client.getContainerClient(container);
    const base = `${containerClient.url}/`;
    const blobName = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
    const blob = blobName ? containerClient.getBlockBlobClient(blobName) : null;
    const unusable = () =>
      new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '사용할 수 없는 파일 주소예요',
      });
    if (!blob || blob.url !== blobUrl) throw unusable();
    let sizeBytes: number | undefined;
    if (verify) {
      const rest = blobName.startsWith(verify.prefix) ? blobName.slice(verify.prefix.length) : '';
      if (!UPLOADED_FILE_NAME.test(rest)) throw unusable();
      try {
        sizeBytes = (await blob.getProperties()).contentLength;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          error.statusCode === 404
        )
          throw new BadRequestException({
            code: ERROR_CODES.VALIDATION,
            message: '올린 파일을 찾을 수 없어요',
          });
        throw new ServiceUnavailableException({
          code: 'UPLOAD_UNAVAILABLE',
          message: '올린 파일을 확인하지 못했어요.',
        });
      }
      if (!sizeBytes)
        throw new BadRequestException({
          code: ERROR_CODES.VALIDATION,
          message: '빈 파일은 올릴 수 없어요',
        });
    }
    const now = Date.now();
    try {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          protocol: SASProtocol.Https,
          startsOn: new Date(now - CLOCK_SKEW_MS),
          expiresOn: new Date(now + ttlMs),
        },
        credential,
      ).toString();
      return { readUrl: `${blob.url}?${sas}`, ...(sizeBytes === undefined ? {} : { sizeBytes }) };
    } catch {
      throw new ServiceUnavailableException({
        code: 'UPLOAD_UNAVAILABLE',
        message: '파일 읽기 주소를 만들지 못했어요.',
      });
    }
  }

  /**
   * 앱이 올린 파일 여러 개가 쓸 수 있는지 본다(필기 사진 검사). 저장소 연결은 한 번만 하고 SAS 는 만들지 않는다.
   * 주소마다 크기 · 저장된 형식(contentType)을 돌려준다. 설정한 컨테이너의 prefix 아래 `<uuid>.<확장자>` 꼴이
   * 아니거나 파일이 없으면 null(저장소를 부르지 않거나 404). 저장소 설정이 없거나 확인하지 못하면 503.
   * 오류 메시지 · 로그에는 주소를 넣지 않는다.
   */
  async inspectUploads(
    blobUrls: string[],
    prefix: string,
  ): Promise<({ sizeBytes: number; contentType: string | null } | null)[]> {
    const { container, client } = await this.storage();
    const containerClient = client.getContainerClient(container);
    const base = `${containerClient.url}/${prefix}`;
    return Promise.all(
      blobUrls.map(async (blobUrl) => {
        const name = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
        if (!UPLOADED_FILE_NAME.test(name)) return null;
        const blob = containerClient.getBlockBlobClient(`${prefix}${name}`);
        if (blob.url !== blobUrl) return null;
        try {
          const properties = await blob.getProperties();
          return {
            sizeBytes: properties.contentLength ?? 0,
            contentType: properties.contentType ?? null,
          };
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'statusCode' in error &&
            error.statusCode === 404
          )
            return null;
          throw new ServiceUnavailableException({
            code: 'UPLOAD_UNAVAILABLE',
            message: '올린 파일을 확인하지 못했어요.',
          });
        }
      }),
    );
  }

  /**
   * 앱이 올린 파일 하나를 지운다(노트 등록이 거절한 파일 정리). 설정한 컨테이너의 prefix 아래
   * `<uuid>.<확장자>` 꼴이 아니면 저장소를 부르지 않는다. 이미 없으면 그대로 끝난다.
   */
  async deleteUpload(blobUrl: string, prefix: string): Promise<void> {
    const { container, client } = await this.storage();
    const containerClient = client.getContainerClient(container);
    const base = `${containerClient.url}/${prefix}`;
    const name = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
    if (!UPLOADED_FILE_NAME.test(name)) return;
    const blob = containerClient.getBlockBlobClient(`${prefix}${name}`);
    if (blob.url !== blobUrl) return;
    await blob.deleteIfExists();
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

  /** AI 사진 검사에 전달할 사용자 소유 이미지의 짧은 읽기 전용 SAS 주소를 만든다. */
  async createImageCheckReadUrl(userId: string, rawUrl: string): Promise<string> {
    const { container, client, credential } = await this.storage();
    const containerClient = client.getContainerClient(container);
    const prefix = `${containerClient.url}/uploads/image/${userId.toLowerCase()}/`;
    if (!rawUrl.startsWith(prefix)) this.invalidImage();

    const fileName = rawUrl.slice(prefix.length);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|heic)$/.test(
        fileName,
      )
    )
      this.invalidImage();

    const blob = containerClient.getBlockBlobClient(
      `uploads/image/${userId.toLowerCase()}/${fileName}`,
    );
    if (blob.url !== rawUrl) this.invalidImage();
    let properties;
    try {
      properties = await blob.getProperties();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 404
      )
        this.invalidImage();
      throw new ServiceUnavailableException({
        code: 'UPLOAD_UNAVAILABLE',
        message: '사진 업로드를 확인하지 못했어요.',
      });
    }

    const extension = fileName.split('.').pop()!;
    const contentType = REPORT_IMAGE_TYPES[extension];
    if (
      !properties.contentLength ||
      properties.contentLength > UPLOAD_RULES.image.maxBytes ||
      properties.contentType !== contentType
    )
      this.invalidImage();

    const now = Date.now();
    try {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName: `uploads/image/${userId.toLowerCase()}/${fileName}`,
          permissions: BlobSASPermissions.parse('r'),
          protocol: SASProtocol.Https,
          startsOn: new Date(now - CLOCK_SKEW_MS),
          expiresOn: new Date(now + IMAGE_CHECK_SAS_LIFETIME_MS),
        },
        credential,
      ).toString();
      return `${blob.url}?${sas}`;
    } catch {
      throw new ServiceUnavailableException({
        code: 'UPLOAD_UNAVAILABLE',
        message: '사진 읽기 주소를 만들지 못했어요.',
      });
    }
  }

  private invalidImage(): never {
    throw new BadRequestException({
      code: 'BAD_REQUEST',
      message: '검사할 사진을 확인할 수 없습니다.',
    });
  }
}
