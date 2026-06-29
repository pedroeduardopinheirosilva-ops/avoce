import { Client } from "minio";

const client = new Client({
  endPoint:  process.env.MINIO_ENDPOINT  ?? "localhost",
  port:      parseInt(process.env.MINIO_PORT ?? "9000", 10),
  useSSL:    process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY ?? "pakt_minio_prod",
  secretKey: process.env.MINIO_SECRET_KEY ?? "PaktMinioProd2026",
});

export const BUCKET_CALLS = process.env.MINIO_BUCKET_CALLS ?? "avoce-calls";

export async function ensureBuckets(): Promise<void> {
  for (const bucket of [BUCKET_CALLS]) {
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket);
      console.log(`[MinIO] Bucket criado: ${bucket}`);
    }
  }
}

export async function uploadBuffer(
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  await client.putObject(bucket, key, buffer, buffer.length, { "Content-Type": contentType });
}

export async function getPresignedUrl(
  bucket: string,
  key: string,
  expirySeconds = 3600
): Promise<string> {
  return client.presignedGetObject(bucket, key, expirySeconds);
}
