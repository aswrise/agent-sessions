import { expect, test } from "bun:test";
import { userDataDirectory } from "../src/paths.ts";

test("uses the established POSIX path and native Windows local app data", () => {
  expect(userDataDirectory("/home/me", {}, "linux")).toBe("/home/me/.local/share/session-snapshots");
  expect(userDataDirectory("C:\\Users\\me", { LOCALAPPDATA: "D:\\Local" }, "win32")).toBe("D:\\Local\\session-snapshots");
});
