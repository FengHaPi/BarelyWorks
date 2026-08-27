import { useCallback, useEffect, useRef, useState } from "react";
import type { Operation, OperationEvent } from "../../../src/shared/api-contracts/agent-first";
import { api } from "../api";

const terminal = new Set<Operation["status"]>(["succeeded", "failed", "cancelled"]);

export function useOperation(operationId: string | null, onTerminal?: (operation: Operation) => void) {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const terminalNotification = useRef<string | null>(null);
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => { terminalNotification.current = null; }, [operationId]);
  useEffect(() => { onTerminalRef.current = onTerminal; }, [onTerminal]);

  const refresh = useCallback(async () => {
    if (!operationId) return;
    try {
      const [operationResponse, eventsResponse] = await Promise.all([
        api.getOperation(operationId), api.getOperationEvents(operationId),
      ]);
      setOperation(operationResponse.operation);
      setEvents(eventsResponse.events);
      setError(null);
      if (terminal.has(operationResponse.operation.status) && terminalNotification.current !== operationResponse.operation.id) {
        terminalNotification.current = operationResponse.operation.id;
        onTerminalRef.current?.(operationResponse.operation);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作业状态载入失败");
    }
  }, [operationId]);

  useEffect(() => {
    if (!operationId) { setOperation(null); setEvents([]); return; }
    void refresh();
    const timer = window.setInterval(() => {
      if (!operation || !terminal.has(operation.status)) void refresh();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [operationId, operation?.status, refresh]);

  const cancel = useCallback(async () => {
    if (!operationId) return;
    const response = await api.cancelOperation(operationId);
    setOperation(response.operation);
    await refresh();
  }, [operationId, refresh]);

  return { operation, events, error, refresh, cancel };
}
