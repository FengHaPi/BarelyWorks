import { describe, expect, it } from "vitest";
import { buildRoughCutArgs, detectRequiredEncoders, displayDimensionsFromProbeStream, resolveMediaToolPaths } from "../src/media/media-toolchain";

describe("FFmpeg rough-cut arguments", () => {
  it("preserves output history and adds silence only for clips without audio", () => {
    const args = buildRoughCutArgs({
      clips: [
        {
          path: "S001.mp4",
          media: { durationSec: 5, width: 1280, height: 720, frameRate: 24, videoCodec: "h264", audioCodec: "aac", hasAudio: true, formatName: "mp4", sizeBytes: 10 },
        },
        {
          path: "S002.mp4",
          media: { durationSec: 4, width: 720, height: 1280, frameRate: 30, videoCodec: "h264", audioCodec: null, hasAudio: false, formatName: "mp4", sizeBytes: 12 },
        },
      ],
      width: 1920,
      height: 1080,
      outputPath: "rough-cut.mp4",
      logPath: "ffmpeg.log",
    });

    expect(args[0]).toBe("-n");
    expect(args.filter((value) => value === "anullsrc=channel_layout=stereo:sample_rate=48000")).toHaveLength(1);
    const filters = args[args.indexOf("-filter_complex") + 1];
    expect(filters).toContain("[0:v:0]");
    expect(filters).toContain("[1:v:0]");
    expect(filters).toContain("[2:a:0]");
    expect(filters).toContain("concat=n=2:v=1:a=1");
  });

  it("prefers explicit paths and otherwise discovers the project-local portable directory", () => {
    const explicit = resolveMediaToolPaths("C:\\studio", {
      AI_VIDEO_STUDIO_FFMPEG_PATH: "D:\\media\\ffmpeg.exe",
      AI_VIDEO_STUDIO_FFPROBE_PATH: "D:\\media\\ffprobe.exe",
    }, "win32", () => false);
    expect(explicit.ffmpegPath).toBe("D:\\media\\ffmpeg.exe");
    expect(explicit.ffprobePath).toBe("D:\\media\\ffprobe.exe");

    const portable = resolveMediaToolPaths("C:\\studio", {}, "win32", (filePath) => filePath.endsWith(".exe"));
    expect(portable.ffmpegPath).toBe("C:\\studio\\tools\\ffmpeg\\bin\\ffmpeg.exe");
    expect(portable.ffprobePath).toBe("C:\\studio\\tools\\ffmpeg\\bin\\ffprobe.exe");
    expect(portable.setupDirectory).toBe("C:\\studio\\tools\\ffmpeg\\bin");
  });

  it("requires both libx264 and AAC encoders for the current rough-cut contract", () => {
    const detected = detectRequiredEncoders(`
 Encoders:
 V....D libx264              libx264 H.264 / AVC
 A..... aac                  AAC (Advanced Audio Coding)
    `);
    expect(detected).toEqual({ libx264Available: true, aacAvailable: true });
    expect(detectRequiredEncoders(" V....D h264_nvenc H.264")).toEqual({ libx264Available: false, aacAvailable: false });
  });

  it("uses display rotation when reporting mobile-video dimensions", () => {
    expect(displayDimensionsFromProbeStream({ width: 1920, height: 1080, tags: { rotate: "90" } })).toEqual({ width: 1080, height: 1920 });
    expect(displayDimensionsFromProbeStream({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] })).toEqual({ width: 1080, height: 1920 });
    expect(displayDimensionsFromProbeStream({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })).toEqual({ width: 1920, height: 1080 });
    expect(displayDimensionsFromProbeStream({ width: 1920, height: 1080, side_data_list: [{ rotation: 45 }] }))
      .toEqual(displayDimensionsFromProbeStream({ width: 1920, height: 1080, side_data_list: [{ rotation: -45 }] }));
  });
});
