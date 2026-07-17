import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DOWNLOAD_URL_TTL_SECONDS } from "@revive-psg1/contracts";
import type { Config } from "./config";

export class ArtifactStorage {
  private readonly client: S3Client | null;

  constructor(private readonly config: Config) {
    this.client = config.spacesAccessKey && config.spacesSecretKey
      ? new S3Client({
          region: config.spacesRegion,
          endpoint: `https://${config.spacesRegion}.digitaloceanspaces.com`,
          credentials: {
            accessKeyId: config.spacesAccessKey,
            secretAccessKey: config.spacesSecretKey
          }
        })
      : null;
  }

  async signedDownloadUrl(objectKey: string): Promise<string> {
    if (!this.client) throw new Error("Artifact storage is not configured");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.spacesBucket, Key: objectKey }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS }
    );
  }
}
