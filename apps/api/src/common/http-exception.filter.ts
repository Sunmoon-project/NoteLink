import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

interface ErrorBody {
  code: string;
  message: string;
}

/**
 * 모든 오류 응답을 README 규칙의 { code, message } 형태로 통일합니다.
 * 서비스에서 던진 { code, message } 페이로드가 있으면 그대로 사용합니다.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(this.toErrorBody(exception, status));
      return;
    }

    this.logger.error('Unhandled exception', exception as Error);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_SERVER_ERROR',
      message: '서버에서 오류가 발생했습니다.',
    });
  }

  private toErrorBody(exception: HttpException, status: number): ErrorBody {
    const payload = exception.getResponse();

    if (typeof payload === 'object' && payload !== null) {
      const obj = payload as Record<string, unknown>;

      // 서비스가 직접 지정한 { code, message }
      if (typeof obj.code === 'string' && typeof obj.message === 'string') {
        return { code: obj.code, message: obj.message };
      }

      // ValidationPipe 등 Nest 기본 오류: message가 배열/문자열로 옴
      if (obj.message !== undefined) {
        const message = Array.isArray(obj.message)
          ? (obj.message as string[]).join(', ')
          : String(obj.message);
        return { code: this.statusToCode(status), message };
      }
    }

    return { code: this.statusToCode(status), message: exception.message };
  }

  private statusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      default:
        return 'ERROR';
    }
  }
}
