import { spawn } from "node:child_process";

export async function signalProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    await new Promise<void>((resolve, reject) => {
      const taskkill = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
      taskkill.once("error", reject);
      taskkill.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
      }
      return;
    }
    throw error;
  }
}
