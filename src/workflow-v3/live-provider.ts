import { CodexCliProvider } from "../ai/codex-cli-provider";
import type { ProviderOperationContext } from "../ai/text-provider";
import type { ContentGeneratorV3, GeneratedContentV3 } from "./contracts";
import { ExistingArtifactContentAdapterV3 } from "./existing-content-adapter";

export const workflowV3LiveStages = [
  "outline",
  "screenplay",
  "asset-bible",
  "shooting-script",
  "storyboard",
] as const;

export type WorkflowV3LiveStage = (typeof workflowV3LiveStages)[number];

export interface WorkflowV3PromptContract {
  promptBuilder: string;
  promptContractVersion: string;
  outputSchemaPath: string;
}

export const workflowV3PromptContracts: Record<WorkflowV3LiveStage, WorkflowV3PromptContract> = {
  outline: {
    promptBuilder: "CodexCliProvider.generateOutline/composeSkillPrompt",
    promptContractVersion: "story-architect-v1",
    outputSchemaPath: "templates/schemas/outline.schema.json",
  },
  screenplay: {
    promptBuilder: "CodexCliProvider.generateScreenplay/composeSkillPrompt",
    promptContractVersion: "screenplay-writer-v1",
    outputSchemaPath: "templates/schemas/screenplay.schema.json",
  },
  "asset-bible": {
    promptBuilder: "CodexCliProvider.generateAssetBible/composeAssetBibleGenerationPrompt",
    promptContractVersion: "asset-bible-builder-v1",
    outputSchemaPath: "templates/schemas/asset-bible.schema.json",
  },
  "shooting-script": {
    promptBuilder: "CodexCliProvider.generateShootingScript/composeShootingScriptGenerationPrompt",
    promptContractVersion: "shooting-script-director-v2",
    outputSchemaPath: "templates/schemas/shooting-script.schema.json",
  },
  storyboard: {
    promptBuilder: "CodexCliProvider.generateStoryboard/composeSkillPrompt",
    promptContractVersion: "storyboard-director-v2",
    outputSchemaPath: "templates/schemas/storyboard.schema.json",
  },
};

export interface WorkflowV3LiveStageRecord {
  stage: WorkflowV3LiveStage;
  status: "started" | "completed" | "failed";
  prompt: WorkflowV3PromptContract;
  provider: "codex-cli";
  model: string;
  runId: string | null;
  threadId: string | null;
  usage: Record<string, unknown> | null;
  eventTypes: string[];
  schemaVersion: string | null;
  route: string[];
  startedAt: string;
  completedAt: string | null;
  providerFailure: string | null;
}

export class WorkflowV3LiveProviderError extends Error {
  constructor(
    readonly stage: WorkflowV3LiveStage,
    readonly record: WorkflowV3LiveStageRecord,
    cause: unknown,
  ) {
    super(`WORKFLOW_V3_LIVE_PROVIDER_FAILED: ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WorkflowV3LiveProviderError";
  }
}

function cloneRecord(record: WorkflowV3LiveStageRecord): WorkflowV3LiveStageRecord {
  return structuredClone(record);
}

export class WorkflowV3CodexLiveProvider implements ContentGeneratorV3 {
  private readonly provider: CodexCliProvider;
  private readonly adapter: ExistingArtifactContentAdapterV3;
  private readonly records: WorkflowV3LiveStageRecord[] = [];
  private readonly model: string;

  constructor(options: {
    repositoryRoot: string;
    projectDirectory: string;
    durationMinSec?: number;
    durationMaxSec?: number;
  }) {
    this.provider = new CodexCliProvider(options.repositoryRoot);
    this.model = this.provider.getTextModel();
    const observedProvider = {
      generateOutline: (input: Parameters<CodexCliProvider["generateOutline"]>[0]) => this.provider.generateOutline({
        ...input,
        operation: this.operation("outline"),
      }),
      generateScreenplay: (input: Parameters<CodexCliProvider["generateScreenplay"]>[0]) => this.provider.generateScreenplay({
        ...input,
        operation: this.operation("screenplay"),
      }),
      generateAssetBible: (input: Parameters<CodexCliProvider["generateAssetBible"]>[0]) => this.provider.generateAssetBible({
        ...input,
        operation: this.operation("asset-bible"),
      }),
      generateShootingScript: (input: Parameters<CodexCliProvider["generateShootingScript"]>[0]) => this.provider.generateShootingScript({
        ...input,
        operation: this.operation("shooting-script"),
      }),
      generateStoryboard: (input: Parameters<CodexCliProvider["generateStoryboard"]>[0]) => this.provider.generateStoryboard({
        ...input,
        operation: this.operation("storyboard"),
      }),
    };
    this.adapter = new ExistingArtifactContentAdapterV3(observedProvider, {
      providerName: "codex-cli",
      model: this.model,
      durationMinSec: options.durationMinSec ?? 5,
      durationMaxSec: options.durationMaxSec ?? 15,
      projectDirectory: options.projectDirectory,
    });
  }

  getTextModel(): string {
    return this.model;
  }

  getStageRecords(): WorkflowV3LiveStageRecord[] {
    return this.records.map(cloneRecord);
  }

  private operation(stage: WorkflowV3LiveStage): ProviderOperationContext {
    return {
      onEvent: (eventType, payload) => {
        const record = this.records.findLast((candidate) => candidate.stage === stage && candidate.status === "started");
        if (!record) return;
        if (eventType === "provider.started") {
          record.runId = typeof payload?.runId === "string" ? payload.runId : record.runId;
          record.model = typeof payload?.model === "string" ? payload.model : record.model;
        } else if (eventType === "provider.failed") {
          record.providerFailure = typeof payload?.message === "string" ? payload.message : "Codex provider failed";
        }
      },
    };
  }

  private async execute<T>(stage: WorkflowV3LiveStage, action: () => Promise<GeneratedContentV3<T>>): Promise<GeneratedContentV3<T>> {
    const record: WorkflowV3LiveStageRecord = {
      stage,
      status: "started",
      prompt: workflowV3PromptContracts[stage],
      provider: "codex-cli",
      model: this.model,
      runId: null,
      threadId: null,
      usage: null,
      eventTypes: [],
      schemaVersion: null,
      route: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      providerFailure: null,
    };
    this.records.push(record);
    try {
      const generated = await action();
      const trace = generated.trace;
      if (trace.provider !== "codex-cli" || !trace.model || !trace.runId || !trace.eventTypes?.includes("turn.completed")) {
        throw new Error(`WORKFLOW_V3_LIVE_TRACE_INVALID: ${stage}`);
      }
      record.status = "completed";
      record.model = trace.model;
      record.runId = trace.runId;
      record.threadId = trace.threadId ?? null;
      record.usage = trace.usage ?? null;
      record.eventTypes = [...trace.eventTypes];
      record.schemaVersion = trace.schemaVersion ?? null;
      record.route = [...(trace.route ?? [])];
      record.completedAt = trace.completedAt;
      return generated;
    } catch (error) {
      record.status = "failed";
      record.completedAt = new Date().toISOString();
      throw new WorkflowV3LiveProviderError(stage, cloneRecord(record), error);
    }
  }

  generateOutline(input: Parameters<ContentGeneratorV3["generateOutline"]>[0]) {
    return this.execute("outline", () => this.adapter.generateOutline(input));
  }

  generateScreenplay(input: Parameters<ContentGeneratorV3["generateScreenplay"]>[0]) {
    return this.execute("screenplay", () => this.adapter.generateScreenplay(input));
  }

  generateAssetBible(input: Parameters<ContentGeneratorV3["generateAssetBible"]>[0]) {
    return this.execute("asset-bible", () => this.adapter.generateAssetBible(input));
  }

  generateShootingScript(input: Parameters<ContentGeneratorV3["generateShootingScript"]>[0]) {
    return this.execute("shooting-script", () => this.adapter.generateShootingScript(input));
  }

  generateStoryboard(input: Parameters<ContentGeneratorV3["generateStoryboard"]>[0]) {
    return this.execute("storyboard", () => this.adapter.generateStoryboard(input));
  }
}
