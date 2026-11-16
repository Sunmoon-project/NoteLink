import { z } from 'zod';
import { UPLOAD_RULES } from '@notelink/shared';

const imageFile = z.object({
  name: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(UPLOAD_RULES.image.maxBytes),
  uri: z.string().url().max(2048),
});

export const CheckImagesBody = z
  .object({ files: z.array(imageFile).min(1).max(20) })
  .superRefine(({ files }, ctx) => {
    if (new Set(files.map((file) => file.name)).size !== files.length)
      ctx.addIssue({ code: 'custom', message: '사진 이름이 중복되었습니다.', path: ['files'] });
  });

export type CheckImageFile = z.infer<typeof imageFile>;
