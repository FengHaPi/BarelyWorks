import type { H3PromptOutput } from "../shared/handoff-schemas";
import { h3PromptTargetCharacters } from "../shared/h3-prompt-budget";
import { referenceRoleDirective } from "../shared/asset-reference-role";

const ref2vaFields = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

type Ref2vaField = (typeof ref2vaFields)[number];

export interface H3PromptReferenceIdentity {
  label: string;
  name: string;
  assetType: string;
  role: string;
}

export interface H3PromptOptimizationResult {
  value: H3PromptOutput;
  targetCharacters: number;
  originalCharacters: number;
  finalCharacters: number;
  referenceOccurrences: Record<string, number>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeReferenceName(reference: H3PromptReferenceIdentity): string {
  return reference.name.replace(/[\r\n]+/g, " ").trim() || reference.label;
}

function splitRef2vaSections(prompt: string): Record<Ref2vaField, string> | null {
  const headerPattern = new RegExp(`(?:^|\\n)(${ref2vaFields.join("|")}):[ \\t]*`, "g");
  const matches = [...prompt.matchAll(headerPattern)];
  if (matches.length !== ref2vaFields.length) return null;
  const sections = {} as Record<Ref2vaField, string>;
  for (const [index, match] of matches.entries()) {
    const field = match[1] as Ref2vaField;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? prompt.length;
    sections[field] = prompt.slice(start, end).trim();
  }
  return sections;
}

function retentionCopy(assetType: string, role: string): string {
  if (["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"].includes(role)) {
    return referenceRoleDirective(role);
  }
  switch (assetType) {
    case "character": return "保持既定人物身份与造型。";
    case "scene": return "保持既定空间、材质与方位。";
    case "prop": return "保持既定道具外观与用途。";
    case "costume": return "保持既定服装造型。";
    case "style": return "保持既定视觉风格。";
    case "audio": return "保持既定声音身份与用途。";
    default: return "保持既定身份与用途。";
  }
}

function replaceAllReferences(text: string, references: H3PromptReferenceIdentity[]): string {
  return references.reduce(
    (current, reference) => current.replace(new RegExp(escapeRegExp(reference.label), "g"), () => safeReferenceName(reference)),
    text,
  );
}

function compactSubjectDefinitions(text: string, references: H3PromptReferenceIdentity[]): string {
  return text.split(/\r?\n/).map((line) => {
    const reference = references.find((item) => line.trimStart().startsWith(item.label));
    if (!reference) return replaceAllReferences(line, references);
    const labelIndex = line.indexOf(reference.label);
    const afterLabel = line.slice(labelIndex + reference.label.length);
    const definition = `${line.slice(0, labelIndex)}${reference.label}${replaceAllReferences(afterLabel, references)}`.replace(/[。；;\s]+$/u, "");
    return `${definition}；参考职责：${referenceRoleDirective(reference.role)}`;
  }).join("\n");
}

function compactRetentionAnalysis(text: string, references: H3PromptReferenceIdentity[]): string {
  const referenceByLabel = new Map(references.map((reference) => [reference.label, reference]));
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    const reference = references.find((item) => trimmed.startsWith(item.label));
    if (!reference) return replaceAllReferences(trimmed, references);
    const marker = trimmed.match(/\b(fully_preserved|partially_preserved|transferred|reused|weak_reference)\b/)?.[1];
    if (marker !== "fully_preserved") return replaceAllReferences(trimmed, references.filter((item) => item.label !== reference.label));
    const rawLocation = trimmed.slice(reference.label.length).match(/^\s*(\([^)]{1,120}\))/)?.[1] ?? "";
    const location = replaceAllReferences(rawLocation, references.filter((item) => item.label !== reference.label));
    const knownReference = referenceByLabel.get(reference.label) ?? reference;
    return `${reference.label}${location ? ` ${location}` : ""}: fully_preserved - ${retentionCopy(knownReference.assetType, knownReference.role)}`;
  }).filter(Boolean).join("\n");
}

function limitExecutionReferences(
  sections: Record<Ref2vaField, string>,
  references: H3PromptReferenceIdentity[],
): Pick<Record<Ref2vaField, string>, "detailed_description" | "overall_soundscape" | "non_diegetic_music"> {
  const used = new Set<string>();
  const replace = (text: string) => references.reduce((current, reference) => current.replace(
    new RegExp(escapeRegExp(reference.label), "g"),
    () => {
      if (!used.has(reference.label)) {
        used.add(reference.label);
        return reference.label;
      }
      return safeReferenceName(reference);
    },
  ), text);
  return {
    detailed_description: replace(sections.detailed_description),
    overall_soundscape: replace(sections.overall_soundscape),
    non_diegetic_music: replace(sections.non_diegetic_music),
  };
}

function countReferences(prompt: string, references: H3PromptReferenceIdentity[]): Record<string, number> {
  return Object.fromEntries(references.map((reference) => [
    reference.label,
    (prompt.match(new RegExp(escapeRegExp(reference.label), "g")) ?? []).length,
  ]));
}

export function optimizeH3Prompt(input: {
  value: H3PromptOutput;
  durationSec: number;
  references: H3PromptReferenceIdentity[];
}): H3PromptOptimizationResult {
  const originalPrompt = input.value.prompt.trim();
  const targetCharacters = h3PromptTargetCharacters(input.durationSec, input.references.length);
  if (input.value.mode !== "Ref2VA") {
    if (originalPrompt.length > targetCharacters) {
      throw new Error(`H3 提示词仍有 ${originalPrompt.length} 字符，超过本镜头精简目标 ${targetCharacters} 字符；已阻止创建冗长版本，请重新生成`);
    }
    return {
      value: input.value,
      targetCharacters,
      originalCharacters: originalPrompt.length,
      finalCharacters: originalPrompt.length,
      referenceOccurrences: countReferences(originalPrompt, input.references),
    };
  }
  const sections = splitRef2vaSections(originalPrompt);
  if (!sections) {
    throw new Error("H3 Ref2VA 提示词字段无法唯一解析；已阻止创建结构不明确的新版本");
  }
  const execution = limitExecutionReferences(sections, input.references);
  const prompt = [
    `subject_definitions:\n${compactSubjectDefinitions(sections.subject_definitions, input.references)}`,
    `summary:\n${replaceAllReferences(sections.summary, input.references)}`,
    `retention_analysis:\n${compactRetentionAnalysis(sections.retention_analysis, input.references)}`,
    `detailed_description:\n${execution.detailed_description}`,
    `overall_soundscape:\n${execution.overall_soundscape}`,
    `non_diegetic_music:\n${execution.non_diegetic_music}`,
  ].join("\n\n").trim();
  const referenceOccurrences = countReferences(prompt, input.references);
  const overused = Object.entries(referenceOccurrences).filter(([, count]) => count > 3);
  if (overused.length) {
    throw new Error(`H3 提示词参考标签重复过多：${overused.map(([label, count]) => `${label} ${count} 次`).join("、")}`);
  }
  if (prompt.length > targetCharacters) {
    throw new Error(`H3 提示词仍有 ${prompt.length} 字符，超过本镜头精简目标 ${targetCharacters} 字符；已阻止创建冗长版本，请重新生成`);
  }
  return {
    value: {
      ...input.value,
      prompt,
      notes: [...input.value.notes, `本地精简完成：${originalPrompt.length} → ${prompt.length} 字符；参考标签最多出现 3 次。`],
    },
    targetCharacters,
    originalCharacters: originalPrompt.length,
    finalCharacters: prompt.length,
    referenceOccurrences,
  };
}
