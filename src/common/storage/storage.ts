import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '@common/errors/domain-error.ts';
import { env } from '@config/env.ts';

/**
 * Neon Object Storage (PRD-v2 §6.7). S3-compatible, and it branches with the
 * database — a preview branch gets its own copy of the objects and of the
 * rows that point at them.
 *
 * Credentials come from the AWS-standard env vars `neon deploy` writes, so
 * the SDK picks up endpoint, region and keys with no wiring. They are read
 * through `env` rather than `process.env` (CLAUDE.md §4.5) only to assert
 * they exist; the SDK still reads the environment itself.
 */

/** Images never transit the API: the client PUTs straight to storage. */
const UPLOAD_URL_TTL_SECONDS = 300;

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** `avatar` -> `avatars/`. Keeps one bucket tidy without a second bucket. */
const PREFIX: Record<string, string> = {
  avatar: 'avatars',
  event_cover: 'event-covers',
};

/** Appendix B / PRD-v2 §6.7: 5 MiB, matching presignBodySchema's own cap. */
export const MAX_UPLOAD_BYTES = 5_242_880;

let s3: S3Client | null = null;

/**
 * The raw S3 client, used only for presigning.
 *
 * `forcePathStyle` is required — Neon does not support virtual-host style
 * addressing. Credentials, endpoint and region come from the AWS-standard
 * env vars, so nothing else is passed.
 */
function s3Client(): S3Client {
  if (!env.S3_BUCKET || !env.AWS_ENDPOINT_URL_S3) {
    throw new DomainError('UPLOAD_002', 'Uploads are not configured on this server.', 503);
  }
  s3 ??= new S3Client({ forcePathStyle: true });
  return s3;
}

export type PresignInput = {
  userId: number;
  purpose: 'avatar' | 'event_cover';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
};

export type PresignResult = {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
};

/**
 * A presigned PUT, plus the URL the object will have once uploaded.
 *
 * The key is server-generated and namespaced by user id. A client-supplied
 * key would let one account overwrite another's avatar, and a predictable
 * key would let anyone guess one — so it is `<prefix>/<userId>/<uuid>.<ext>`
 * and the random part is what makes it unguessable.
 *
 * The extension is derived from the DECLARED content type, which the client
 * controls. That is not a validation: `contentType` is a claim, and the
 * magic bytes are only checked after the object lands (PRD-v2 §6.7). The
 * bucket is public_read, so until that check exists, treat an uploaded
 * object as attacker-controlled bytes served from our origin.
 */
export async function presignUpload(input: PresignInput): Promise<PresignResult> {
  const extension = EXTENSION[input.contentType];
  const prefix = PREFIX[input.purpose];
  if (!extension || !prefix) {
    throw new DomainError('UPLOAD_001', 'Unsupported upload type.', 400);
  }
  // Belt and braces with presignBodySchema: this function is also callable
  // from a job or a future route that does not go through that schema.
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new DomainError('UPLOAD_001', 'Declared size must be a positive integer.', 400);
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new DomainError('UPLOAD_001', 'That file is too large.', 400, {
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  const key = `${prefix}/${input.userId}/${crypto.randomUUID()}.${extension}`;

  // `ContentLength` and `ContentType` are SIGNED headers, which is the point.
  //
  // Validating sizeBytes in the schema alone only checks what the client
  // CLAIMS: the signed URL it got back would still accept a 5 GB body, so
  // the declared cap bought nothing and anyone with an account could fill
  // the bucket. Signing them means storage rejects a PUT whose actual
  // length or type differs from the one the signature was issued for.
  const uploadUrl = await getSignedUrl(
    s3Client(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentLength: input.sizeBytes,
      ContentType: input.contentType,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-length', 'content-type']),
    },
  );

  return {
    uploadUrl,
    publicUrl: objectUrl(key),
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  };
}

/**
 * Where an object in a public_read bucket is readable.
 *
 * Path-style, which is what Neon requires — virtual-host style addressing is
 * not supported.
 */
export function objectUrl(key: string): string {
  const base = (env.AWS_ENDPOINT_URL_S3 ?? '').replace(/\/$/, '');
  return `${base}/${env.S3_BUCKET}/${key}`;
}
