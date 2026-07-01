import { describe, expect, test } from "bun:test";
import { bar, formatResetIn, formatUsage, parseUsagePayload } from "../src/limits";

describe("parseUsagePayload", () => {
  test("extracts five_hour and seven_day windows", () => {
    const snapshot = parseUsagePayload({
      five_hour: { utilization: 83.0, resets_at: "2026-07-01T22:00:00+00:00" },
      seven_day: { utilization: 81.0, resets_at: "2026-07-02T09:00:00+00:00" },
      seven_day_opus: null,
    });
    expect(snapshot.fiveHour).toEqual({ utilization: 83, resetsAt: "2026-07-01T22:00:00+00:00" });
    expect(snapshot.sevenDay?.utilization).toBe(81);
  });

  test("tolerates missing/null windows and garbage", () => {
    expect(parseUsagePayload({ five_hour: null }).fiveHour).toBeNull();
    expect(parseUsagePayload({}).sevenDay).toBeNull();
    expect(parseUsagePayload(null).fiveHour).toBeNull();
    expect(parseUsagePayload({ five_hour: { resets_at: "x" } }).fiveHour).toBeNull();
  });
});

describe("display", () => {
  test("bar renders percent-left proportionally", () => {
    expect(bar(100)).toBe("[============]");
    expect(bar(0)).toBe("[------------]");
    expect(bar(17)).toBe("[==----------]");
    expect(bar(-5)).toBe("[------------]");
  });

  test("formatResetIn renders durations", () => {
    const now = Date.parse("2026-07-01T12:00:00Z");
    expect(formatResetIn("2026-07-01T12:52:00Z", now)).toBe("resets in 52m");
    expect(formatResetIn("2026-07-01T16:30:00Z", now)).toBe("resets in 4h 30m");
    expect(formatResetIn("2026-07-03T13:00:00Z", now)).toBe("resets in 2d 1h");
    expect(formatResetIn("2026-07-01T11:00:00Z", now)).toBe("resets now");
    expect(formatResetIn(null, now)).toBe("reset unknown");
  });

  test("formatUsage renders codexbar-style lines", () => {
    const lines = formatUsage({
      fiveHour: { utilization: 83, resetsAt: "2026-07-01T12:52:00Z" },
      sevenDay: null,
      fetchedAt: Date.parse("2026-07-01T12:00:00Z"),
    });
    expect(lines[0]).toBe("Session (5h): 17% left [==----------] resets in 52m");
    expect(lines[1]).toBe("Weekly (7d) : unavailable");
  });
});
