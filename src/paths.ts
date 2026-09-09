import { posix, win32 } from "node:path";

export function homeDirectory(env = process.env): string {
  const snapHome = env.SNAP_REAL_HOME && env.HOME === env.SNAP_USER_DATA ? env.SNAP_REAL_HOME : undefined;
  const home = snapHome ?? env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("无法确定用户目录");
  return home;
}

export function userDataDirectory(home: string, env = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "session-snapshots")
    : posix.join(home, ".local", "share", "session-snapshots");
}
