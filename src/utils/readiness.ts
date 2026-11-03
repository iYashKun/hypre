export async function waitForHttpReady(address: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Readiness check aborted");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.min(1000, deadline - Date.now()));
    try {
      const response = await fetch(address, { signal: controller.signal });
      void response.body?.cancel();
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const pauseMs = Math.min(100, deadline - Date.now());
    if (pauseMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }

  throw new Error(`Readiness check timed out after ${timeoutMs}ms at ${address}: ${lastError}`);
}
