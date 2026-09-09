import { expect, test } from "bun:test";
import { homeDirectory, userDataDirectory } from "../src/paths.ts";

test("uses the established POSIX path and native Windows local app data", () => {
  expect(userDataDirectory("/home/me", {}, "linux")).toBe("/home/me/.local/share/session-snapshots");
  expect(userDataDirectory("C:\\Users\\me", { LOCALAPPDATA: "D:\\Local" }, "win32")).toBe("D:\\Local\\session-snapshots");
});

test("uses the real home directory under Snap Bun", () => {
  expect(homeDirectory({ HOME: "/home/me/snap/bun/1", SNAP_REAL_HOME: "/home/me", SNAP_USER_DATA: "/home/me/snap/bun/1" })).toBe("/home/me");
  expect(homeDirectory({ HOME: "/tmp/fixture", SNAP_REAL_HOME: "/home/me", SNAP_USER_DATA: "/home/me/snap/bun/1" })).toBe("/tmp/fixture");
});
