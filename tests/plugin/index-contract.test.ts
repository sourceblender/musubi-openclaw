import { beforeEach, describe, expect, it, vi } from "vitest";

const registerMusubi = vi.fn();
vi.mock("../../src/plugin/bootstrap.js", () => ({ registerMusubi }));

describe("plugin entry contract", () => {
  beforeEach(() => registerMusubi.mockReset());

  it("exports a first-class memory definition and delegates registration synchronously", async () => {
    vi.resetModules();
    const entry = (await import("../../src/index.js")).default;
    const api = { pluginConfig: { core: {} } };

    // The manifest owns the exclusive kind; runtime kind is deprecated.
    expect(entry.kind).toBeUndefined();
    entry.register?.(api as never);
    expect(registerMusubi).toHaveBeenCalledWith({ api, rawConfig: api.pluginConfig });
  });
});
