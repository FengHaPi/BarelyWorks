import type { AssetReferencePromptRecord, Asset, Project } from "../shared/schemas";

export interface ImageProviderCapabilities {
  provider: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  requiresPayment: boolean;
  supportsTextToImage: boolean;
  supportedMimeTypes: Array<"image/png" | "image/jpeg" | "image/webp">;
  reason: string | null;
}

export interface GenerateAssetReferenceImageInput {
  project: Project;
  asset: Asset;
  prompt: AssetReferencePromptRecord;
}

export interface GeneratedAssetReferenceImage {
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
  providerTaskId: string | null;
}

export interface ImageGenerationProvider {
  getCapabilities(): Promise<ImageProviderCapabilities>;
  generateAssetReferenceImage(input: GenerateAssetReferenceImageInput): Promise<GeneratedAssetReferenceImage>;
}

export class DisabledImageGenerationProvider implements ImageGenerationProvider {
  async getCapabilities(): Promise<ImageProviderCapabilities> {
    return {
      provider: "unconfigured",
      displayName: "图像生成 API（预留）",
      configured: false,
      enabled: false,
      requiresPayment: true,
      supportsTextToImage: true,
      supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      reason: "尚未配置图像生成 Provider；当前由本地 Codex 生成可复制提示词，不会调用付费图片 API。",
    };
  }

  async generateAssetReferenceImage(): Promise<GeneratedAssetReferenceImage> {
    throw new Error("图像生成 API 尚未配置；Codex 只能生成参考图提示词，不能输出图片。提示词已保留，可复制到任意图像平台或稍后接入 Provider。");
  }
}
