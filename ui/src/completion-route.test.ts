import { describe, expect, it } from "vitest";
import { shouldOpenDeliveryComplete } from "./completion-route";

describe("delivery completion routing", () => {
  it("opens the completion start page for an already delivered project", () => {
    expect(shouldOpenDeliveryComplete("DELIVERED")).toBe(true);
  });

  it("keeps unfinished projects in their normal workflow", () => {
    expect(shouldOpenDeliveryComplete("FINAL_REVIEW")).toBe(false);
    expect(shouldOpenDeliveryComplete("GENERATION_REVIEW")).toBe(false);
    expect(shouldOpenDeliveryComplete(undefined)).toBe(false);
  });
});
