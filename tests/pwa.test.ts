import { describe, expect, it } from "vitest";
import { OFFLINE_READY_TEXT, updateNoticeText } from "../src/ui/updateBanner.ts";

describe("update notice", () => {
  it("warns that updating ends the connection only while connected", () => {
    expect(updateNoticeText(true)).toMatch(/ends the connection/);
    expect(updateNoticeText(false)).not.toMatch(/connection/);
    expect(updateNoticeText(false)).toMatch(/new version/);
  });
  it("says the app works offline", () => {
    expect(OFFLINE_READY_TEXT).toMatch(/without a network/);
  });
});
