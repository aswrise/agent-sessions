import { posix, win32 } from "node:path";

export function userDataDirectory(home: string, env = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "session-snapshots")
    : posix.join(home, ".local", "share", "session-snapshots");
}
