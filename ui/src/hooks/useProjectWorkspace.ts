import { useCallback, useEffect, useState } from "react";
import type { ProjectWorkspace } from "../../../src/shared/api-contracts/agent-first";
import { api } from "../api";

export function useProjectWorkspace(projectId: string) {
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const response = await api.getWorkspace(projectId);
      setWorkspace(response.workspace);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作区载入失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); void reload(); }, [reload]);
  return { workspace, loading, error, reload, setWorkspace };
}
