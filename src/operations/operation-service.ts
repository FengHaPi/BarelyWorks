import type { Operation, OperationEvent } from "../shared/api-contracts/agent-first";
import { OperationRepository, type CreateOperationInput } from "./operation-repository";
import { OperationRunner } from "./operation-runner";

export class OperationService {
  constructor(private readonly operations: OperationRepository, private readonly runner: OperationRunner) {}

  create(input: CreateOperationInput): Operation {
    const result = this.operations.create(input);
    if (result.operation.status === "queued") this.runner.schedule(result.operation.id);
    return result.operation;
  }

  get(id: string): Operation {
    return this.operations.require(id);
  }

  events(id: string): OperationEvent[] {
    this.operations.require(id);
    return this.operations.listEvents(id);
  }

  listProject(projectId: string): Operation[] {
    return this.operations.listProject(projectId);
  }

  cancel(id: string): Promise<Operation> {
    return this.runner.cancel(id);
  }
}
