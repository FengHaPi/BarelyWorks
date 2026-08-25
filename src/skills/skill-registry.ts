import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const studioSkillNames = [
  "ai-video-producer",
  "project-intake",
  "story-architect",
  "screenplay-writer",
  "asset-bible-builder",
  "shooting-script-director",
  "storyboard-director",
  "continuity-supervisor",
  "video-quality-reviewer",
] as const;

export type StudioSkillName = (typeof studioSkillNames)[number];

export interface SkillProvenance {
  name: string;
  version: string;
  sha256: string;
  sourceFiles: string[];
}

export interface LoadedSkill {
  provenance: SkillProvenance;
  description: string;
  instructionText: string;
  references: Array<{ path: string; content: string }>;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseSkillDocument(content: string): { frontmatter: SkillFrontmatter; instructionText: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 缺少有效 YAML frontmatter");
  const frontmatter = parseYaml(match[1]) as SkillFrontmatter;
  return { frontmatter, instructionText: match[2].trim() };
}

function referencedMarkdownFiles(content: string): string[] {
  const references = new Set<string>();
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split("#", 1)[0];
    if (target && !/^[a-z]+:/i.test(target)) references.add(target);
  }
  return [...references].sort();
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export class SkillRegistry {
  private readonly skillsRoot: string;
  private readonly pluginManifestPath: string;

  constructor(private readonly runtimeRoot: string) {
    this.skillsRoot = path.resolve(runtimeRoot, "skills");
    this.pluginManifestPath = path.resolve(runtimeRoot, ".codex-plugin", "plugin.json");
  }

  async load(name: StudioSkillName): Promise<LoadedSkill> {
    if (!studioSkillNames.includes(name)) throw new Error(`Skill 不在允许清单中：${name}`);
    const skillDirectory = path.resolve(this.skillsRoot, name);
    if (!isInsideOrEqual(this.skillsRoot, skillDirectory)) throw new Error(`Skill 路径越界：${name}`);

    const manifest = JSON.parse(await fs.readFile(this.pluginManifestPath, "utf8")) as { version?: unknown };
    if (typeof manifest.version !== "string" || !manifest.version.trim()) {
      throw new Error("插件清单缺少有效版本号");
    }

    const skillPath = path.join(skillDirectory, "SKILL.md");
    const skillContent = await fs.readFile(skillPath, "utf8");
    const parsed = parseSkillDocument(skillContent);
    if (parsed.frontmatter.name !== name) {
      throw new Error(`Skill 名称不匹配：目录为 ${name}，frontmatter 为 ${String(parsed.frontmatter.name)}`);
    }
    if (typeof parsed.frontmatter.description !== "string" || !parsed.frontmatter.description.trim()) {
      throw new Error(`Skill 缺少有效描述：${name}`);
    }

    const references: LoadedSkill["references"] = [];
    for (const referencedPath of referencedMarkdownFiles(skillContent)) {
      const absolutePath = path.resolve(skillDirectory, referencedPath);
      if (!isInsideOrEqual(skillDirectory, absolutePath)) {
        throw new Error(`Skill 引用路径越界：${name}/${referencedPath}`);
      }
      references.push({ path: portablePath(referencedPath), content: await fs.readFile(absolutePath, "utf8") });
    }

    const hash = createHash("sha256");
    const sourceFiles = ["SKILL.md", ...references.map((item) => item.path)];
    const contentByPath = new Map<string, string>([["SKILL.md", skillContent], ...references.map((item) => [item.path, item.content] as const)]);
    for (const relativePath of [...sourceFiles].sort()) {
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(contentByPath.get(relativePath) ?? "", "utf8");
      hash.update("\0");
    }

    return {
      provenance: {
        name,
        version: manifest.version,
        sha256: hash.digest("hex"),
        sourceFiles,
      },
      description: parsed.frontmatter.description,
      instructionText: parsed.instructionText,
      references,
    };
  }

  async loadMany(names: readonly StudioSkillName[]): Promise<LoadedSkill[]> {
    return Promise.all(names.map((name) => this.load(name)));
  }
}
