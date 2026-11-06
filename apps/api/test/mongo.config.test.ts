import { describe, expect, it } from 'vitest';

import { type ConfigReader, createMongooseOptions } from '../src/config/mongo.config.js';

function configOf(values: Record<string, string>): ConfigReader {
  return { get: (key) => values[key] };
}

describe('createMongooseOptions', () => {
  it('MONGODB_URI를 그대로 uri로 넘긴다', () => {
    const uri = 'mongodb://localhost:27017/notelink';

    expect(createMongooseOptions(configOf({ MONGODB_URI: uri }))).toEqual({ uri });
  });

  it('URI 앞뒤 공백은 지운다', () => {
    const options = createMongooseOptions(
      configOf({ MONGODB_URI: '  mongodb://localhost:27017/notelink\n' }),
    );

    expect(options.uri).toBe('mongodb://localhost:27017/notelink');
  });

  it('MONGODB_URI가 없으면 실패한다', () => {
    expect(() => createMongooseOptions(configOf({}))).toThrow('MONGODB_URI');
  });

  it.each(['', '   '])('MONGODB_URI가 비어 있으면(%j) 실패한다', (value) => {
    expect(() => createMongooseOptions(configOf({ MONGODB_URI: value }))).toThrow('MONGODB_URI');
  });

  it('오류 문구에 URI 값을 넣지 않는다', () => {
    let message = '';
    try {
      createMongooseOptions(
        configOf({ MONGODB_URI: '   ', OTHER: 'mongodb://user:secret@host/db' }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('MONGODB_URI');
    expect(message).not.toContain('secret');
  });
});
