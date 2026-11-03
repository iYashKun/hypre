const colors = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };

function log(level: string, color: string, message: string): void {
  const time = new Date().toLocaleTimeString();
  const output = `${colors.gray}[${time}]${colors.reset} ${color}[${level}]${colors.reset} ${message}`;
  if (level === "ERROR") console.error(output);
  else console.log(output);
}

export const logger = {
  info: (message: string) =>
    log("INFO", colors.cyan, message),
  success: (message: string) =>
    log("SUCCESS", colors.green, message),
  build: (message: string) =>
    log("BUILD", colors.cyan, message),
  status: (message: string) =>
    log("STATUS", colors.gray, message),
  watch: (message: string) =>
    log("WATCH", colors.cyan, message),
  warn: (message: string) =>
    log("WARN", colors.yellow, message),
  error: (message: string) =>
    log("ERROR", colors.red, message),
  change: (message: string) =>
    log("CHANGE", colors.yellow, message)
};
