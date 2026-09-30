import { describe, expect, test } from "bun:test";
import { configDir, dbPath, locksDir, spoolDir, stateDir } from "./paths";

const HOME = "/home/owner";

describe("the XDG layout", () => {
  test("defaults each directory under the home directory", () => {
    const env = { HOME };
    expect(configDir(env)).toBe("/home/owner/.config/dim");
    expect(dbPath(env)).toBe("/home/owner/.local/share/dim-factory/record/sessions.db");
    expect(stateDir(env)).toBe("/home/owner/.local/state/dim-factory");
  });

  test("follows an absolute XDG variable for each directory", () => {
    const env = { HOME, XDG_CONFIG_HOME: "/x/config", XDG_DATA_HOME: "/x/data", XDG_STATE_HOME: "/x/state" };
    expect(configDir(env)).toBe("/x/config/dim");
    expect(dbPath(env)).toBe("/x/data/dim-factory/record/sessions.db");
    expect(stateDir(env)).toBe("/x/state/dim-factory");
  });

  test("ignores a relative or empty XDG variable, as the XDG spec says", () => {
    const env = { HOME, XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "", XDG_STATE_HOME: "./state" };
    expect(configDir(env)).toBe("/home/owner/.config/dim");
    expect(dbPath(env)).toBe("/home/owner/.local/share/dim-factory/record/sessions.db");
    expect(stateDir(env)).toBe("/home/owner/.local/state/dim-factory");
  });

  test("keeps the record and its spool in their own directory, and the locks in state", () => {
    const env = { HOME, XDG_DATA_HOME: "/x/data", XDG_STATE_HOME: "/x/state" };
    expect(dbPath(env)).toBe("/x/data/dim-factory/record/sessions.db");
    expect(spoolDir(env)).toBe("/x/data/dim-factory/record/spool");
    expect(locksDir(env)).toBe("/x/state/dim-factory/locks");
  });
});
