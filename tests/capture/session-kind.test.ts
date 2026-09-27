import { isCronSessionKey as hostIsCronSessionKey } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";

import { isCronSessionKey } from "../../src/capture/session-kind.js";

const CRON = [
  "agent:rika:cron:0f7c2c7e-5b7e-4d0a-9d55-2a8f0c1b6e11",
  "agent:vesper:cron:nightly:run:7d1c",
  "AGENT:Rika:CRON:job",
  "  agent:rika:cron:job  ",
  "agent:main:cron:",
];

const NOT_CRON = [
  undefined,
  "",
  "cron:job",
  "agent:rika:main",
  "agent:rika:main:heartbeat",
  "agent:rika:discord:channel:1491960562035331214",
  "agent:rika:peer:rika:vesper",
  "agent:vesper:acc-probe",
  "agent:rika:crontab",
  "agent:rika:discord:cron:channel",
  "agent::cron:job",
  "agent:rika::cron:job",
  "agent:rika",
];

describe("isCronSessionKey", () => {
  it("recognises OpenClaw scheduled-run keys, including per-run scopes", () => {
    for (const key of CRON) expect(isCronSessionKey(key), key).toBe(true);
  });

  it("does not treat channel, main, peer, heartbeat or look-alike keys as cron", () => {
    for (const key of NOT_CRON) expect(isCronSessionKey(key), String(key)).toBe(false);
  });

  it("agrees with the host's own classifier on every vector", () => {
    for (const key of [...CRON, ...NOT_CRON]) {
      expect(isCronSessionKey(key), String(key)).toBe(hostIsCronSessionKey(key));
    }
  });
});
