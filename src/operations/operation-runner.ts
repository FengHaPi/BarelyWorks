import type { Operation } from "../shared/api-contracts/agent-first";
import { OperationRepository } from "./operation-repository";
import { NativeProcessController, type ProcessController } from "./process-controller";

export interface OperationContext {
  operation: Operation;
  signal: AbortSignal;
  event(eventType: string, payload?: Record<string, unknown>): void;
  progress(phase: string, current?: number | null, total?: number | null, payload?: Record<string, unknown>): void;
  setProcessId(processId: number | null): void;
}

export type OperationHandler = (context: OperationContext) => Promise<Record<string, unknown>>;

export class OperationExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OperationExecutionError";
  }
}

interface RunningOperation {
  controller: AbortController;
  processId: number | null;
  promise: Promise<void>;
}

export class OperationRunner {
  private readonly handlers = new Map<string, OperationHandler>();
  private readonly running = new Map<string, RunningOperation>();
  private closed = false;

  constructor(
    private readonly operations: OperationRepository,
    private readonly processController: ProcessController = new NativeProcessController(),
    private readonly heartbeatMs = 2_000,
  ) {}

  register(kind: string, handler: OperationHandler): void {
    this.handlers.set(kind, handler);
  }

  recover(): Operation[] {
    const cutoff = new Date(Date.now() - Math.max(this.heartbeatMs * 3, 10_000)).toISOString();
    const recovered = this.operations.recoverInterrupted(cutoff);
    for (const operation of this.operations.listQueued()) this.schedule(operation.id);
    return recovered;
  }

  schedule(operationId: string): void {
    if (this.closed || this.running.has(operationId)) return;
    queueMicrotask(() => { void this.run(operationId); });
  }

  async cancel(operationId: string): Promise<Operation> {
    let operation = this.operations.requestCancel(operationId);
    const running = this.running.get(operationId);
    if (running && operation.status === "cancel_requested") {
      running.controller.abort(new Error("用户取消作业"));
      if (running.processId) {
        try {
          await this.processController.terminateTree(running.processId);
          this.operations.appendEvent(operationId, "operation.process-tree-terminated", { processId: running.processId });
        } catch (error) {
          this.operations.appendEvent(operationId, "operation.process-tree-termination-failed", {
            processId: running.processId, message: error instanceof Error ? error.message : "进程树终止失败",
          });
        }
      }
      // The handler owns final cleanup. Do not claim cancellation until it has
      // observed AbortSignal and actually left the running set.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running.promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 5_000);
          timeout.unref();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      operation = this.operations.require(operationId);
    }
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, running] of this.running) {
      running.controller.abort(new Error("应用正在关闭"));
      if (running.processId) await this.processController.terminateTree(running.processId).catch(() => undefined);
      this.operations.fail(id, "APP_SHUTDOWN", "应用关闭时停止了运行中的作业", true);
    }
    await Promise.allSettled([...this.running.values()].map((item) => item.promise));
  }

  private async run(operationId: string): Promise<void> {
    if (this.closed || this.running.has(operationId)) return;
    const claimed = this.operations.claim(operationId);
    if (!claimed) return;
    const handler = this.handlers.get(claimed.kind);
    if (!handler) {
      this.operations.fail(operationId, "NO_OPERATION_HANDLER", `没有注册 ${claimed.kind} 作业处理器`, false);
      return;
    }
    const controller = new AbortController();
    let processId: number | null = null;
    let resolveRunning!: () => void;
    const promise = new Promise<void>((resolve) => { resolveRunning = resolve; });
    this.running.set(operationId, { controller, processId, promise });
    const heartbeat = setInterval(() => this.operations.heartbeat(operationId), this.heartbeatMs);
    heartbeat.unref();
    const context: OperationContext = {
      operation: claimed,
      signal: controller.signal,
      event: (eventType, payload = {}) => { this.operations.appendEvent(operationId, eventType, payload); },
      progress: (phase, current, total, payload = {}) => { this.operations.updateProgress(operationId, phase, current, total, payload); },
      setProcessId: (id) => {
        processId = id;
        const current = this.running.get(operationId);
        if (current) current.processId = id;
        this.operations.setProcessId(operationId, id);
      },
    };
    try {
      const result = await handler(context);
      if (controller.signal.aborted) this.operations.markCancelled(operationId);
      else this.operations.succeed(operationId, result);
    } catch (error) {
      if (controller.signal.aborted) this.operations.markCancelled(operationId, error instanceof Error ? error.message : "作业已取消");
      else if (error instanceof OperationExecutionError) {
        this.operations.fail(operationId, error.code, error.message, error.retryable, error.details);
      } else this.operations.fail(operationId, "OPERATION_FAILED", error instanceof Error ? error.message : "作业执行失败", false, {
          completedActions: [], unexecutedActions: [claimed.kind],
        });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(operationId);
      resolveRunning();
    }
  }
}
