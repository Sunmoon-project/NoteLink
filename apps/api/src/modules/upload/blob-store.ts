import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

import type { StorageConfig } from '../../config/storage.config.js';

export const BLOB_STORE = Symbol('BLOB_STORE');

/** 올라간 파일을 서버가 확인 · 정리할 때 쓰는 저장소 동작 */
export interface BlobStore {
  /** 실제 크기(바이트). 없으면 null */
  size(blobName: string): Promise<number | null>;
  /** 지운다. 이미 없어도 성공 */
  remove(blobName: string): Promise<void>;
}

export class AzureBlobStore implements BlobStore {
  private readonly container;

  constructor(storage: StorageConfig) {
    const credential = new StorageSharedKeyCredential(storage.accountName, storage.accountKey);
    this.container = new BlobServiceClient(storage.blobEndpoint, credential).getContainerClient(
      storage.container,
    );
  }

  async size(blobName: string): Promise<number | null> {
    try {
      const props = await this.container.getBlobClient(blobName).getProperties();
      return props.contentLength ?? 0;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }

  async remove(blobName: string): Promise<void> {
    await this.container.getBlobClient(blobName).deleteIfExists();
  }
}

/** 저장소 설정이 없으면 null(올리기 · 정리를 하지 않는다) */
export function createBlobStore(storage: StorageConfig | null): BlobStore | null {
  return storage ? new AzureBlobStore(storage) : null;
}
