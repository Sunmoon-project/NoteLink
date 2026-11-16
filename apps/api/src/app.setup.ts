import { ValidationPipe, type INestApplication } from '@nestjs/common';

import { HttpExceptionFilter } from './common/http-exception.filter.js';

/** main.ts와 테스트가 같은 설정을 쓰도록 모아 둡니다. 주소는 /api/v1/... (README 5장) */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');

  // DTO 검증: 정의되지 않은 필드는 제거하고, 모르는 필드가 오면 거부합니다.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 오류 응답을 { code, message }로 통일합니다.
  app.useGlobalFilters(new HttpExceptionFilter());
}
