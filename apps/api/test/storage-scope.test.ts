import { describe, expect, it, vi } from 'vitest';

import { StorageScopeService } from '../src/modules/upload/storage-scope.service.js';

const SCOPE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const found = (value: unknown) => ({
  lean: () => ({
    orFail: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
  }),
});
const make = () => {
  const model = { findOneAndUpdate: vi.fn() };
  return { model, service: new StorageScopeService(model as never) };
};

describe('DB의 저장소 구분값 (StorageScopeService)', () => {
  it('없을 때만 새 값을 넣고, 한 번 읽은 값은 다시 묻지 않는다', async () => {
    const { model, service } = make();
    model.findOneAndUpdate.mockReturnValue(found({ scope: SCOPE }));

    expect(await service.get()).toBe(SCOPE);
    expect(await service.get()).toBe(SCOPE);

    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = model.findOneAndUpdate.mock.calls[0]!;
    expect(filter).toEqual({ _id: 'default' });
    expect(Object.keys(update)).toEqual(['$setOnInsert']);
    expect(options).toEqual({ upsert: true, new: true });
  });

  it('처음 만드는 요청이 겹쳐 유일 키에 걸리면 한 번 더 읽는다', async () => {
    const { model, service } = make();
    model.findOneAndUpdate
      .mockReturnValueOnce(found(Object.assign(new Error('중복'), { code: 11000 })))
      .mockReturnValueOnce(found({ scope: SCOPE }));
    expect(await service.get()).toBe(SCOPE);
  });

  it('읽지 못하면 던지고, 다음에 다시 읽는다', async () => {
    const { model, service } = make();
    model.findOneAndUpdate
      .mockReturnValueOnce(found(new Error('DB 장애')))
      .mockReturnValueOnce(found({ scope: SCOPE }));
    await expect(service.get()).rejects.toThrow('DB 장애');
    expect(await service.get()).toBe(SCOPE);
  });
});
