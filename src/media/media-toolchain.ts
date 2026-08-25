import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { MediaMetadata, MediaToolStatus } from "../shared/quality-schemas";
import { mediaMetadataSchema, mediaToolStatusSchema } from "../shared/quality-schemas";

interface ProcessResult { stdout: string; stderr: string }

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} 执行超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-1_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-1_000_000); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} 失败（退出码 ${code ?? "未知"}）：${stderr.slice(-800)}`));
    });
  });
}

function parseFrameRate(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export interface RoughCutClip { path: string; media: MediaMetadata }
export interface RoughCutRequest {
  clips: RoughCutClip[];
  width: number;
  height: number;
  outputPath: string;
  logPath: string;
}

export interface MediaToolchain {
  getStatus(): Promise<MediaToolStatus>;
  probe(filePath: string): Promise<MediaMetadata>;
  renderRoughCut(request: RoughCutRequest): Promise<void>;
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
  private readonly ffmpegPath = process.env.AI_VIDEO_STUDIO_FFMPEG_PATH?.trim() || "ffmpeg";
  private readonly ffprobePath = process.env.AI_VIDEO_STUDIO_FFPROBE_PATH?.trim() || "ffprobe";

  async getStatus(): Promise<MediaToolStatus> {
    const [ffmpeg, ffprobe] = await Promise.all([
      runProcess(this.ffmpegPath, ["-version"], 10_000).then((result) => result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || null).catch(() => null),
      runProcess(this.ffprobePath, ["-version"], 10_000).then((result) => result.stdout.split(/\r?\n/)[0] || result.stderr.split(/\r?\n/)[0] || null).catch(() => null),
    ]);
    return mediaToolStatusSchema.parse({
      ffmpegAvailable: Boolean(ffmpeg), ffprobeAvailable: Boolean(ffprobe),
      ffmpegVersion: ffmpeg, ffprobeVersion: ffprobe,
      ffmpegPath: this.ffmpegPath, ffprobePath: this.ffprobePath,
    });
  }

  async probe(filePath: string): Promise<MediaMetadata> {
    const result = await runProcess(this.ffprobePath, [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
    ], 60_000).catch((error: NodeJS.ErrnoException) => {
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
    return mediaMetadataSchema.parse({
      durationSec,
      width: Number(video.width),
      height: Number(video.height),
      frameRate: parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate),
      videoCodec: String(video.codec_name ?? ""),
      audioCodec: audio ? String(audio.codec_name ?? "") : null,
      hasAudio: Boolean(audio),
      formatName: String(payload.format?.format_name ?? "unknown"),
      sizeBytes: stat.size,
    });
  }

  async renderRoughCut(request: RoughCutRequest): Promise<void> {
    const args = buildRoughCutArgs(request);
    try {
      const result = await runProcess(this.ffmpegPath, args, 30 * 60_000);
      await fs.writeFile(request.logPath, `${result.stdout}\n${result.stderr}`, "utf8");
    } catch (error) {
      await fs.writeFile(request.logPath, error instanceof Error ? error.message : String(error), "utf8").catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("未找到 FFmpeg。请先安装 FFmpeg，或设置 AI_VIDEO_STUDIO_FFMPEG_PATH");
      throw error;
    }
  }
}
