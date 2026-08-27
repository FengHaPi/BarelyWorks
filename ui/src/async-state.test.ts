import { describe, expect, it, vi } from "vitest";
import { formatRefreshWarning, runMutationWithRefresh } from "./async-state";

describe("runMutationWithRefresh", () => {
  it("preserves the successful result when the follow-up refresh fails", async () => {
    const onSuccess = vi.fn();
    const outcome = await runMutationWithRefresh({
      mutate: async () => ({ id: "saved" }),
      onSuccess,
      refresh: async () => { throw new Error("读取列表失败"); },
    });

    expect(outcome.result).toEqual({ id: "saved" });
    expect(onSuccess).toHaveBeenCalledWith({ id: "saved" });
    expect(outcome.refreshError?.message).toBe("读取列表失败");
    expect(formatRefreshWarning(outcome.refreshError!)).toContain("操作已成功");
  });

  it("still rejects when the mutation itself fails", async () => {
    const onSuccess = vi.fn();
    const refresh = vi.fn();
    await expect(runMutationWithRefresh({
      mutate: async () => { throw new Error("提交失败"); },
      onSuccess,
      refresh,
    })).rejects.toThrow("提交失败");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
