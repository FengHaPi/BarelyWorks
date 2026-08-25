import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FfmpegMediaToolchain } from "../src/media/media-toolchain";

interface CommandResult { stdout: string; stderr: string }

function run(command: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} 媒体自检超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)} 媒体自检失败（退出码 ${code ?? "未知"}）：${stderr.slice(-1_000)}`));
    });
  });
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const toolchain = new FfmpegMediaToolchain(projectRoot);
const status = await toolchain.getStatus();
if (!status.roughCutReady) {
  throw new Error(`媒体工具链未就绪：${JSON.stringify(status)}`);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-studio-media-smoke-"));
let verified = false;
try {
  const clipWithAudio = path.join(temporaryRoot, "clip-with-audio.mp4");
  const clipWithoutAudio = path.join(temporaryRoot, "clip-without-audio.mp4");
  const roughCut = path.join(temporaryRoot, "rough-cut.mp4");
  const ffmpegLog = path.join(temporaryRoot, "ffmpeg-rough-cut.log");

  await run(status.ffmpegPath, [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x2846aa:s=320x240:r=24:d=1.200",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.200",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clipWithAudio,
  ]);
  await run(status.ffmpegPath, [
    "-y",
    "-f", "lavfi", "-i", "color=c=0xb53555:s=240x320:r=30:d=0.800",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", clipWithoutAudio,
  ]);

  const first = await toolchain.probe(clipWithAudio);
  const second = await toolchain.probe(clipWithoutAudio);
  if (!first.hasAudio || second.hasAudio) throw new Error("音轨探测结果与自检素材不一致");

  await toolchain.renderRoughCut({
    clips: [
      { path: clipWithAudio, media: first },
      { path: clipWithoutAudio, media: second },
    ],
    width: 640,
    height: 360,
    outputPath: roughCut,
    logPath: ffmpegLog,
  });
  const output = await toolchain.probe(roughCut);
  if (output.width !== 640 || output.height !== 360) throw new Error(`粗剪分辨率错误：${output.width}x${output.height}`);
  if (!output.hasAudio || output.audioCodec !== "aac") throw new Error("粗剪没有生成预期 AAC 音轨");
  if (output.videoCodec !== "h264") throw new Error(`粗剪视频编码器不是 H.264：${output.videoCodec}`);
  if (output.durationSec < 1.9 || output.durationSec > 2.3) throw new Error(`粗剪时长超出自检容差：${output.durationSec}`);

  verified = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ffmpegVersion: status.ffmpegVersion,
    ffprobeVersion: status.ffprobeVersion,
    inputs: [first, second],
    roughCut: output,
  }, null, 2)}\n`);
} finally {
  if (verified) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`媒体自检失败，诊断文件保留在：${temporaryRoot}\n`);
  }
}
