import { describe, expect, it } from "vitest";

import { readSpeechTestFixture } from "./speech-test-fixture";

describe("PWR-05 test fixture gate", () => {
  it("does not let a local query parameter enable Fake without the explicit test switch", () => {
    expect(readSpeechTestFixture("review", "local-research", false)).toBeUndefined();
  });

  it("keeps the Fake fixture disabled in public-demo even when the switch and query are present", () => {
    expect(readSpeechTestFixture("review", "public-demo", true)).toBeUndefined();
  });

  it("accepts only a recognized flow when local research and the explicit switch are enabled", () => {
    expect(readSpeechTestFixture("review", "local-research", true)).toEqual({ flow: "review", expanded: false });
    expect(readSpeechTestFixture("unknown", "local-research", true)).toBeUndefined();
  });
});
