import { describe, expect, it } from "vitest";
import { assignSendSlots, HOUR_MS } from "../scheduler";

const START = new Date("2026-01-01T10:00:00.000Z");
const t = (d: Date) => d.getTime() - START.getTime();

describe("assignSendSlots", () => {
  it("returns [] when count is 0", () => {
    expect(assignSendSlots(0, START, 1000, 10)).toEqual([]);
  });

  it("spaces recipients by exactly delayMs within a window", () => {
    const slots = assignSendSlots(5, START, 2000, 100);

    expect(slots.map((s) => t(s.scheduledAt))).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(slots.every((s) => s.windowIndex === 0)).toBe(true);
  });

  it("starts the next window at the hour boundary once hourlyLimit is reached", () => {
    const slots = assignSendSlots(5, START, 1000, 2);

    expect(slots.map((s) => s.windowIndex)).toEqual([0, 0, 1, 1, 2]);
    // First recipient of each new window lands exactly on start + windowIndex * HOUR_MS
    expect(t(slots[2].scheduledAt)).toBe(1 * HOUR_MS);
    expect(t(slots[4].scheduledAt)).toBe(2 * HOUR_MS);
    // ...and spacing by delayMs resumes inside that window
    expect(t(slots[3].scheduledAt)).toBe(1 * HOUR_MS + 1000);
  });

  it("delayMs = 0 with hourlyLimit = 3 and 7 recipients gives windows [0,0,0,1,1,1,2]", () => {
    const slots = assignSendSlots(7, START, 0, 3);

    expect(slots.map((s) => s.windowIndex)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(slots.map((s) => t(s.scheduledAt))).toEqual([
      0,
      0,
      0,
      HOUR_MS,
      HOUR_MS,
      HOUR_MS,
      2 * HOUR_MS,
    ]);
  });

  it("hourlyLimit = 1 puts each recipient in its own window", () => {
    const slots = assignSendSlots(4, START, 1000, 1);

    expect(slots.map((s) => s.windowIndex)).toEqual([0, 1, 2, 3]);
    slots.forEach((s, i) => expect(t(s.scheduledAt)).toBe(i * HOUR_MS));
  });
});
