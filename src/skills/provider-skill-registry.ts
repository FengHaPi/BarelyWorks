import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoadedSkill } from "./skill-registry";

export const providerSkillNames = ["h3-prompt-writing", "updream-handoff"] as const;
export type ProviderSkillName = (typeof providerSkillNames)[number];

interface LockFile {
  skills?: Record<string, { commit?: unknown; ref?: unknown; version?: unknown; sha256?: unknown }>;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function collectReferenceFiles(directory: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectReferenceFiles(absolutePath, base));
    else if (entry.isFile()) files.push(portablePath(path.relative(base, absolutePath)));
  }
  return files.sort();
}

export class ProviderSkillRegistry {
  private readonly skillsRoot: string;
  private readonly lockPath: string;

  constructor(runtimeRoot: string) {
    this.skillsRoot = path.resolve(runtimeRoot, "provider-skills");
    this.lockPath = path.join(this.skillsRoot, "skills-lock.json");
  }

  async load(name: ProviderSkillName): Promise<LoadedSkill> {
    if (!providerSkillNames.includes(name)) throw new Error(`Provider Skill 不在允许清单中：${name}`);
    const skillDirectory = path.resolve(this.skillsRoot, name);
    if (!isInsideOrEqual(this.skillsRoot, skillDirectory)) throw new Error(`Provider Skill 路径越界：${name}`);
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const skillContent = await fs.readFile(skillPath, "utf8");
    const match = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error(`Provider Skill 缺少有效 YAML frontmatter：${name}`);
    const frontmatter = parseYaml(match[1]) as { name?: unknown; description?: unknown };
    if (frontmatter.name !== name) throw new Error(`Provider Skill 名称不匹配：${name}`);
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
      throw new Error(`Provider Skill 缺少有效描述：${name}`);
    }

    const referencePaths = await collectReferenceFiles(path.join(skillDirectory, "references"), skillDirectory);
    const references: LoadedSkill["references"] = [];
    for (const relativePath of referencePaths) {
      const absolutePath = path.resolve(skillDirectory, relativePath);
      if (!isInsideOrEqual(skillDirectory, absolutePath)) throw new Error(`Provider Skill 引用路径越界：${name}/${relativePath}`);
      references.push({ path: relativePath, content: await fs.readFile(absolutePath, "utf8") });
    }

    const lock = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as LockFile;
    const entry = lock.skills?.[name];
    const version = typeof entry?.version === "string"
      ? entry.version
      : typeof entry?.commit === "string"
        ? `${typeof entry.ref === "string" ? entry.ref : "commit"}@${entry.commit.slice(0, 12)}`
        : "unversioned";
    const hash = createHash("sha256");
    const sourceFiles = ["SKILL.md", ...references.map((item) => item.path)];
    const contentByPath = new Map<string, string>([["SKILL.md", skillContent], ...references.map((item) => [item.path, item.content] as const)]);
    for (const relativePath of [...sourceFiles].sort()) {
      hash.update(relativePath, "utf8");
      hash.update("\0");
      hash.update(contentByPath.get(relativePath) ?? "", "utf8");
      hash.update("\0");
    }
    const sha256 = hash.digest("hex");
    if (typeof entry?.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error(`Provider Skill 锁文件缺少有效内容哈希：${name}`);
    }
    if (sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(`Provider Skill 内容与锁文件不一致：${name}`);
    }
    return {
      provenance: { name, version, sha256, sourceFiles },
      description: frontmatter.description,
      instructionText: match[2].trim(),
      references,
    };
  }

  async loadMany(names: readonly ProviderSkillName[]): Promise<LoadedSkill[]> {
    return Promise.all(names.map((name) => this.load(name)));
  }
}
