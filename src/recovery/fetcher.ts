import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { RecoveryFailure } from "./errors.js";

const RIPE_MRT_HOST = "data.ris.ripe.net";
const RIPE_UPDATE_PATH = /^\/rrc\d{2}\/\d{4}\.\d{2}\/updates\.\d{8}\.\d{4}\.gz$/;

export function assertOfficialRipeMrtUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "Invalid RIPE MRT URL", error);
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== RIPE_MRT_HOST
    || url.port !== ""
    || Boolean(url.username)
    || Boolean(url.password)
    || Boolean(url.search)
    || Boolean(url.hash)
    || !RIPE_UPDATE_PATH.test(url.pathname)
  ) {
    throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "Recovery URL is outside the fixed RIPE MRT allowlist");
  }
  return url;
}

async function fetchBounded(url: URL): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(config.recoveryDownloadTimeoutMs),
        headers: {
          "user-agent": "BAYKUSH-Intel-Node/NODE-6.2",
          "accept-encoding": "identity",
        },
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new RecoveryFailure(
        name.includes("Timeout") ? "DOWNLOAD_TIMEOUT" : "DOWNLOAD_TLS_ERROR",
        "RIPE MRT download failed",
        error,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "RIPE redirect omitted Location");
      const next = assertOfficialRipeMrtUrl(new URL(location, current).toString());
      if (next.hostname !== current.hostname) {
        throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "Cross-host MRT redirect rejected");
      }
      current = next;
      continue;
    }
    return response;
  }
  throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "Too many MRT redirects");
}

async function assertGzipMagic(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(2);
    const read = await handle.read(buffer, 0, 2, 0);
    if (read.bytesRead !== 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
      throw new RecoveryFailure("GZIP_INVALID", "RIPE MRT artifact does not have a gzip header");
    }
  } finally {
    await handle.close();
  }
}

export interface DownloadedMrtArtifact {
  sourceUrl: string;
  sha256: string;
  compressedBytes: number;
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  stagingKey: string;
  absolutePath: string;
  downloadedAt: string;
  expiresAt: string;
}

export async function downloadRipeMrtArtifact(input: {
  segmentId: string;
  sourceUrl: string;
  windowEnd: string;
}): Promise<DownloadedMrtArtifact> {
  if (!/^[0-9a-f-]{36}$/i.test(input.segmentId)) {
    throw new RecoveryFailure("DOWNLOAD_REDIRECT_REJECTED", "Invalid recovery segment identity");
  }
  const url = assertOfficialRipeMrtUrl(input.sourceUrl);
  await mkdir(config.recoveryStagingDir, { recursive: true, mode: 0o700 });
  const filesystem = await statfs(config.recoveryStagingDir);
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (available < config.recoveryMinFreeDiskBytes) {
    throw new RecoveryFailure("DISK_WATERMARK", "Recovery staging disk watermark reached");
  }

  const response = await fetchBounded(url);
  if (response.status === 404) {
    const settleUntil = Date.parse(input.windowEnd) + config.recoveryArchiveSettleSeconds * 1_000;
    throw new RecoveryFailure(
      Date.now() < settleUntil ? "ARCHIVE_NOT_READY" : "HTTP_NOT_FOUND",
      `RIPE MRT artifact returned HTTP 404: ${url.pathname}`,
    );
  }
  if (response.status === 429) throw new RecoveryFailure("HTTP_RATE_LIMITED", "RIPE MRT archive rate limited recovery");
  if (response.status >= 500) throw new RecoveryFailure("HTTP_SERVER_ERROR", `RIPE MRT archive returned HTTP ${response.status}`);
  if (!response.ok || !response.body) throw new RecoveryFailure("HTTP_NOT_FOUND", `RIPE MRT archive returned HTTP ${response.status}`);

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > config.recoveryMaxArtifactBytes) {
    throw new RecoveryFailure("DOWNLOAD_SIZE_LIMIT", "RIPE MRT artifact exceeds compressed-byte limit");
  }

  const directory = path.join(config.recoveryStagingDir, input.segmentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${randomUUID()}.mrt.gz`;
  const absolutePath = path.join(directory, name);
  const stagingKey = `${input.segmentId}/${name}`;
  const writer = createWriteStream(absolutePath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > config.recoveryMaxArtifactBytes) {
        await reader.cancel();
        throw new RecoveryFailure("DOWNLOAD_SIZE_LIMIT", "RIPE MRT artifact exceeded compressed-byte limit while streaming");
      }
      hash.update(item.value);
      if (!writer.write(item.value)) await once(writer, "drain");
    }
    writer.end();
    await once(writer, "close");
    if (bytes === 0) throw new RecoveryFailure("GZIP_INVALID", "Downloaded RIPE MRT artifact is empty");
    await assertGzipMagic(absolutePath);
  } catch (error) {
    writer.destroy();
    await rm(absolutePath, { force: true });
    if (error instanceof RecoveryFailure) throw error;
    throw new RecoveryFailure("DOWNLOAD_TLS_ERROR", "RIPE MRT streaming download failed", error);
  }

  const downloadedAt = new Date();
  return {
    sourceUrl: url.toString(),
    sha256: hash.digest("hex"),
    compressedBytes: bytes,
    httpStatus: response.status,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    stagingKey,
    absolutePath,
    downloadedAt: downloadedAt.toISOString(),
    expiresAt: new Date(downloadedAt.getTime() + config.recoveryArtifactRetentionHours * 3_600_000).toISOString(),
  };
}
