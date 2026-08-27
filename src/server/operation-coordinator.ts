export class OperationInProgressError extends Error {
  constructor(readonly key: string) {
    super("该项目已有操作正在进行，请等待完成后再试");
    this.name = "OperationInProgressError";
  }
}

export interface OperationStatus {
  key: string;
  operation: string;
  phase: string;
  phaseLabel: string;
  startedAt: string;
  phaseStartedAt: string;
}

export interface OperationStatusInput {
  operation: string;
  phase: string;
  phaseLabel: string;
}

export class OperationCoordinator {
  private readonly inFlight = new Map<string, OperationStatus>();

  async run<T>(key: string, operation: () => Promise<T>, status?: OperationStatusInput): Promise<T> {
    if (this.inFlight.has(key)) throw new OperationInProgressError(key);
    const startedAt = new Date().toISOString();
    this.inFlight.set(key, {
      key,
      operation: status?.operation ?? "project.operation",
      phase: status?.phase ?? "running",
      phaseLabel: status?.phaseLabel ?? "正在处理项目操作",
      startedAt,
      phaseStartedAt: startedAt,
    });
    try {
      return await operation();
    } finally {
      this.inFlight.delete(key);
    }
  }

  update(key: string, status: Pick<OperationStatusInput, "phase" | "phaseLabel">): OperationStatus | null {
    const current = this.inFlight.get(key);
    if (!current) return null;
    const updated = { ...current, ...status, phaseStartedAt: new Date().toISOString() };
    this.inFlight.set(key, updated);
    return { ...updated };
  }

  get(key: string): OperationStatus | null {
    const current = this.inFlight.get(key);
    return current ? { ...current } : null;
  }
}
