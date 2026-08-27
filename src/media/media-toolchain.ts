import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaMetadata, MediaToolStatus } from "../shared/quality-schemas";
import { mediaMetadataSchema, mediaToolStatusSchema } from "../shared/quality-schemas";

interface ProcessResult { stdout: string; stderr: string }
export interface MediaProcessContext {
  signal?: AbortSignal;
  onProcessId?: (processId: number | null) => void;
}

async function runProcess(command: string, args: string[], timeoutMs: number, context: MediaProcessContext = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    context.onProcessId?.(child.pid ?? null);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", onAbort);
      context.onProcessId?.(null);
      error ? reject(error) : resolve({ stdout, stderr });
    };
    const onAbort = () => { child.kill(); finish(new Error(`${command} 已取消`)); };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} 执行超时`));
    }, timeoutMs);
    timeout.unref();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) return onAbort();
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_000_000); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      code === 0 ? finish() : finish(new Error(`${command} 失败（退出码 ${code ?? "未知"}）：${stderr.slice(-800)}`));
    });
  });
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export function displayDimensionsFromProbeStream(video: Record<string, unknown>): { width: number; height: number } {
  const coded = { width: Number(video.width), height: Number(video.height) };
  const tags = video.tags && typeof video.tags === "object" ? video.tags as Record<string, unknown> : null;
  const sideData = Array.isArray(video.side_data_list) ? video.side_data_list as Array<Record<string, unknown>> : [];
  const rotationValue = sideData.find((item) => Number.isFinite(Number(item.rotation)))?.rotation ?? tags?.rotate ?? 0;
  const rotation = Number(rotationValue);
  if (!Number.isFinite(rotation)) return coded;
  const normalized = ((rotation % 360) + 360) % 360;
  if (Math.abs(normalized - 90) < 0.01 || Math.abs(normalized - 270) < 0.01) {
    return { width: coded.height, height: coded.width };
  }
  if (Math.abs(normalized) < 0.01 || Math.abs(normalized - 180) < 0.01 || Math.abs(normalized - 360) < 0.01) return coded;
  const radians = normalized * Math.PI / 180;
  return {
    width: Math.round(Math.abs(coded.width * Math.cos(radians)) + Math.abs(coded.height * Math.sin(radians))),
    height: Math.round(Math.abs(coded.width * Math.sin(radians)) + Math.abs(coded.height * Math.cos(radians))),
  };
}

export interface RoughCutClip { path: string; media: MediaMetadata }
export interface RoughCutRequest {
  clips: RoughCutClip[];
  width: number;
  height: number;
  outputPath: string;
  logPath: string;
  signal?: AbortSignal;
  onProcessId?: (processId: number | null) => void;
}

export interface ReviewFrameRequest {
  inputPath: string;
  durationSec: number;
  outputDirectory: string;
  signal?: AbortSignal;
  onProcessId?: (processId: number | null) => void;
}

export interface MediaToolchain {
  getStatus(): Promise<MediaToolStatus>;
  probe(filePath: string, context?: MediaProcessContext): Promise<MediaMetadata>;
  extractReviewFrames(request: ReviewFrameRequest): Promise<string[]>;
  renderRoughCut(request: RoughCutRequest): Promise<void>;
}

export interface MediaToolPaths {
  ffmpegPath: string;
  ffprobePath: string;
  setupDirectory: string;
}

export function resolveMediaToolPaths(
  runtimeRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (filePath: string) => boolean = existsSync,
): MediaToolPaths {
  const setupDirectory = path.join(runtimeRoot, "tools", "ffmpeg", "bin");
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const portableFfmpeg = path.join(setupDirectory, `ffmpeg${executableSuffix}`);
  const portableFfprobe = path.join(setupDirectory, `ffprobe${executableSuffix}`);
  return {
    ffmpegPath: environment.AI_VIDEO_STUDIO_FFMPEG_PATH?.trim() || (fileExists(portableFfmpeg) ? portableFfmpeg : "ffmpeg"),
    ffprobePath: environment.AI_VIDEO_STUDIO_FFPROBE_PATH?.trim() || (fileExists(portableFfprobe) ? portableFfprobe : "ffprobe"),
    setupDirectory,
  };
}

export function detectRequiredEncoders(value: string): { libx264Available: boolean; aacAvailable: boolean } {
  const encoderNames = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) encoderNames.add(match[1]);
  }
  return {
    libx264Available: encoderNames.has("libx264"),
    aacAvailable: encoderNames.has("aac"),
  };
}

export function buildRoughCutArgs(request: RoughCutRequest): string[] {
  const args: string[] = ["-n"];
  const inputIndexes: Array<{ video: number; audio: number }> = [];
  let inputIndex = 0;
  for (const clip of request.clips) {
    const video = inputIndex;
    args.push("-i", clip.path);
    inputIndex += 1;
    let audio = video;
    if (!clip.media.hasAudio) {
      audio = inputIndex;
      args.push("-f", "lavfi", "-t", clip.media.durationSec.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      inputIndex += 1;
    }
    inputIndexes.push({ video, audio });
  }
  const filters: string[] = [];
  inputIndexes.forEach((input, index) => {
    filters.push(`[${input.video}:v:0]scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${index}]`);
    filters.push(`[${input.audio}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
  });
  filters.push(`${inputIndexes.map((_input, index) => `[v${index}][a${index}]`).join("")}concat=n=${inputIndexes.length}:v=1:a=1[outv][outa]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", request.outputPath,
  );
  return args;
}

export class FfmpegMediaToolchain implements MediaToolchain {
  private static readonly statusCacheTtlMs = 5 * 60_000;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly setupDirectory: string;
  private statusCache: { value: MediaToolStatus; expiresAt: number } | null = null;
  private statusPromise: Promise<MediaToolStatus> | null = null;

  constructor(runtimeRoot = process.cwd()) {
    const paths = resolveMediaToolPaths(runtimeRoot);
    this.ffmpegPath = paths.ffmpegPath;
    this.ffprobePath = paths.ffprobePath;
    this.setupDirectory = paths.setupDirectory;
  }

  async getStatus(): Promise<MediaToolStatus> {
    if (this.statusCache && this.statusCache.expiresAt > Date.now()) return this.statusCache.value;
    if (this.statusPromise) return this.statusPromise;
    this.statusPromise = this.inspectStatus()
      .then((value) => {
        this.statusCache = { value, expiresAt: Date.now() + FfmpegMediaToolchain.statusCacheTtlMs };
        return value;
      })
      .finally(() => { this.statusPromise = null; });
    return this.statusPromise;
  }

  private async inspectStatus(): Promise<MediaToolStatus> {
    const [ffmpeg, ffprobe] = await Promise.all([
      runProcess(this.ffmpegPath, ["-version"], 10_000).then((result) => result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || null).catch(() => null),
      runProcess(this.ffprobePath, ["-version"], 10_000).then((result) => result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || null).catch(() => null),
    ]);
    const encoderOutput = ffmpeg
      ? await runProcess(this.ffmpegPath, ["-hide_banner", "-encoders"], 20_000).then((result) => result.stdout || result.stderr).catch(() => "")
      : "";
    const encoders = detectRequiredEncoders(encoderOutput);
    return mediaToolStatusSchema.parse({
      ffmpegAvailable: Boolean(ffmpeg), ffprobeAvailable: Boolean(ffprobe),
      ...encoders,
      roughCutReady: Boolean(ffmpeg) && Boolean(ffprobe) && encoders.libx264Available && encoders.aacAvailable,
      ffmpegVersion: ffmpeg, ffprobeVersion: ffprobe,
      ffmpegPath: this.ffmpegPath, ffprobePath: this.ffprobePath,
      setupDirectory: this.setupDirectory,
    });
  }

  async probe(filePath: string, context: MediaProcessContext = {}): Promise<MediaMetadata> {
    const result = await runProcess(this.ffprobePath, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
    ], 60_000, context).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("未找到 ffprobe。请先安装 FFmpeg，或设置 AI_VIDEO_STUDIO_FFPROBE_PATH");
      throw error;
    });
    const payload = JSON.parse(result.stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    const video = payload.streams?.find((stream) => stream.codec_type === "video");
    const audio = payload.streams?.find((stream) => stream.codec_type === "audio");
    if (!video) throw new Error("导入文件没有可识别的视频流");
    const durationSec = Number(payload.format?.duration ?? video.duration);
    const stat = await fs.stat(filePath);
    const displayDimensions = displayDimensionsFromProbeStream(video);
    return mediaMetadataSchema.parse({
      durationSec,
      ...displayDimensions,
      frameRate: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      videoCodec: String(video.codec_name ?? ""),
      audioCodec: audio ? String(audio.codec_name ?? "") : null,
      hasAudio: Boolean(audio),
      formatName: String(payload.format?.format_name ?? "unknown"),
      sizeBytes: stat.size,
    });
  }

  async extractReviewFrames(request: ReviewFrameRequest): Promise<string[]> {
    await fs.mkdir(request.outputDirectory, { recursive: true });
    const positions = [
      Math.min(0.05, request.durationSec * 0.1),
      request.durationSec * 0.5,
      Math.max(0, request.durationSec - Math.min(0.05, request.durationSec * 0.1)),
    ];
    const outputs: string[] = [];
    for (const [index, position] of positions.entries()) {
      const outputPath = path.join(request.outputDirectory, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
      await runProcess(this.ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", position.toFixed(3), "-i", request.inputPath,
        "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
        "-q:v", "2", outputPath,
      ], 120_000, request).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error("未找到 FFmpeg，无法抽取质检关键帧");
        throw error;
      });
      outputs.push(outputPath);
    }
    return outputs;
  }

  async renderRoughCut(request: RoughCutRequest): Promise<void> {
    const args = buildRoughCutArgs(request);
    try {
      const result = await runProcess(this.ffmpegPath, args, 30 * 60_000, request);
      await fs.writeFile(request.logPath, `${result.stdout}\n${result.stderr}`, "utf8");
    } catch (error) {
      await fs.writeFile(request.logPath, error instanceof Error ? error.message : String(error), "utf8").catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("未找到 FFmpeg。请先安装 FFmpeg，或设置 AI_VIDEO_STUDIO_FFMPEG_PATH");
      throw error;
    }
  }
}
