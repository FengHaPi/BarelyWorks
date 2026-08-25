import { describe, expect, it } from "vitest";
import { buildRoughCutArgs } from "../src/media/media-toolchain";

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
});
