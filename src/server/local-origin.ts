export function localBrowserOrigins(apiPort = 4317, developmentPort = 5173): Set<string> {
  for (const port of [apiPort, developmentPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("本地界面端口无效");
  }
  return new Set([
    `http://127.0.0.1:${apiPort}`,
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${developmentPort}`,
    `http://localhost:${developmentPort}`,
  ]);
}

export function isAllowedBrowserOrigin(origin: string | undefined, allowedOrigins = localBrowserOrigins()): boolean {
  return origin === undefined || allowedOrigins.has(origin);
}
