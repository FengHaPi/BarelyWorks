import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { skillOutputSchemas } from "../src/shared/skill-schemas";

const fixtures = JSON.parse(
  fs.readFileSync(path.resolve("tests/fixtures/skills/p0-valid.json"), "utf8"),
) as Record<string, unknown>;

describe("P0 Skill output contracts", () => {
  for (const [name, schema] of Object.entries(skillOutputSchemas)) {
    it(`${name} accepts its maintained valid fixture`, () => {
      expect(schema.safeParse(fixtures[name]).success).toBe(true);
    });
  }

  it("rejects a shooting-script fixture whose duration no longer matches its timecode", () => {
    const bad = structuredClone(fixtures["shooting-script-director"]) as {
      shots: Array<{ durationSec: number }>;
    };
    bad.shots[0].durationSec = 44;
    expect(skillOutputSchemas["shooting-script-director"].safeParse(bad).success).toBe(false);
  });
});
