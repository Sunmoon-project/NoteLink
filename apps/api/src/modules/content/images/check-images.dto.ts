import { z } from 'zod';
import { IMAGE_CHECK_MAX_FILES, UPLOAD_RULES } from '@notelink/shared';

const imageFile = z.object({
  name: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(UPLOAD_RULES.image.maxBytes),
  uri: z.string().url().max(2048),
});

export const CheckImagesBody = z
  .object({ files: z.array(imageFile).min(1).max(IMAGE_CHECK_MAX_FILES) })
  .superRefine(({ files }, ctx) => {
    if (new Set(files.map((file) => file.name)).size !== files.length)
      ctx.addIssue({ code: 'custom', message: '사진 이름이 중복되었습니다.', path: ['files'] });
    // 같은 사진을 두 번 읽으면 AI 글자 인식 비용만 두 번 든다(노트 등록도 같은 파일을 두 번 받지 않는다)
    if (new Set(files.map((file) => file.uri)).size !== files.length)
      ctx.addIssue({
        code: 'custom',
        message: '같은 사진이 두 번 들어 있습니다.',
        path: ['files'],
      });
  });

export type CheckImageFile = z.infer<typeof imageFile>;
