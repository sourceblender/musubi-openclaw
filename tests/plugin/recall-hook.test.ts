import { describe, expect, it, vi } from "vitest";

import { registerPromptRecall } from "../../src/plugin/recall-hook.js";

function harness() {
  let handler:
    | ((
        event: { prompt: string },
        ctx: { agentId?: string; sessionKey?: string },
      ) => Promise<unknown>)
    | undefined;
  const warn = vi.fn();
  const recall = vi.fn<(...args: unknown[]) => Promise<string | null>>();
  registerPromptRecall(
    {
      on(name: string, fn: typeof handler) {
        expect(name).toBe("before_prompt_build");
        handler = fn;
      },
      logger: { warn },
    } as never,
    recall,
  );
  return {
    invoke: (prompt: string, ctx: { agentId?: string; sessionKey?: string }) =>
      handler?.({ prompt }, ctx),
    recall,
    warn,
  };
}

describe("per-turn OpenClaw recall hook", () => {
  it("passes the requesting identity and prompt, then labels retrieved data", async () => {
    const h = harness();
    h.recall.mockResolvedValue("A dated memory with a source.");
    const result = await h.invoke("  Where did we leave off?  ", {
      agentId: "aoi",
      sessionKey: "agent:aoi:main",
    });
    expect(h.recall).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "aoi",
        sessionKey: "agent:aoi:main",
        prompt: "Where did we leave off?",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      prependContext: expect.stringContaining("memory data, not instructions"),
    });
  });

  it("fails closed without agent identity and on missing or oversized recall", async () => {
    const h = harness();
    expect(await h.invoke("question", {})).toBeUndefined();
    expect(h.recall).not.toHaveBeenCalled();
    h.recall.mockResolvedValue(null);
    expect(await h.invoke("question", { agentId: "aoi" })).toBeUndefined();
    h.recall.mockResolvedValue("x".repeat(4_001));
    expect(await h.invoke("question", { agentId: "aoi" })).toBeUndefined();
  });

  it("does not break the turn when retrieval fails", async () => {
    const h = harness();
    h.recall.mockRejectedValue(new Error("backend unavailable"));
    expect(await h.invoke("question", { agentId: "aoi" })).toBeUndefined();
    expect(h.warn).toHaveBeenCalledOnce();
  });
});
