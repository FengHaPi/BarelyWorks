export interface MutationWithRefreshResult<T> {
  result: T;
  refreshError: Error | null;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason || "未知错误"));
}

export async function runMutationWithRefresh<T>({
  mutate,
  onSuccess,
  refresh,
}: {
  mutate: () => Promise<T>;
  onSuccess?: (result: T) => void;
  refresh: (result: T) => Promise<void>;
}): Promise<MutationWithRefreshResult<T>> {
  const result = await mutate();
  onSuccess?.(result);
  try {
    await refresh(result);
    return { result, refreshError: null };
  } catch (reason) {
    return { result, refreshError: asError(reason) };
  }
}

export function formatRefreshWarning(reason: Error, label = "最新数据"): string {
  return `操作已成功，但${label}刷新失败：${reason.message}。当前成功状态已保留，可稍后重试。`;
}
