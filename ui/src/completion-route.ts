import type { ProjectStage } from "./types";

export function shouldOpenDeliveryComplete(stage: ProjectStage | undefined): boolean {
  return stage === "DELIVERED";
}
