import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { ArchiveStore } from "./types.js";

export interface S3ArchiveConfig {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** S3-compatible archive store (works with AWS S3, R2, MinIO, etc.) */
export class S3ArchiveStore implements ArchiveStore {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: S3ArchiveConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";

    const clientConfig: ConstructorParameters<typeof S3Client>[0] = {
      region: config.region ?? "auto",
    };

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      clientConfig.forcePathStyle = true;
    }

    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: typeof data === "string" ? Buffer.from(data, "utf-8") : data,
        ContentType: "application/jsonl",
      })
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        })
      );
      return (await res.Body?.transformToString("utf-8")) ?? null;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "NoSuchKey") return null;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.fullKey(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) {
          // Strip the store prefix to return relative keys
          const rel = this.prefix ? obj.Key.slice(this.prefix.length + 1) : obj.Key;
          keys.push(rel);
        }
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      })
    );
  }
}
