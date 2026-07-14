import { join } from "node:path";

export function userDataDirectory(home: string, env = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "session-snapshots")
    : join(home, ".local", "share", "session-snapshots");
}
