import { describe, expect, it } from "vitest";
import { nextInRotation, withPick } from "../../routes/training";

const routines = [
  { id: "d1", weekdays: [], exercises: [{}] },
  { id: "d2", weekdays: [], exercises: [{}] },
  { id: "rest", weekdays: [], exercises: [] },
  { id: "d3", weekdays: [], exercises: [{}] },
];

describe("withPick", () => {
  const planned = nextInRotation(routines, null, "2026-11-24");

  it("keeps the plan when nothing is picked", () => {
    expect(withPick(planned, routines, null)).toEqual({ routine_id: "d1", state: "first", picked: false, planned_routine_id: "d1" });
  });

  it("a picked rest day is today's rest, and remembers the plan", () => {
    expect(withPick(planned, routines, "rest")).toEqual({ routine_id: "rest", state: "rest", picked: true, planned_routine_id: "d1" });
  });

  it("a picked workout is up next", () => {
    expect(withPick(planned, routines, "d3")).toMatchObject({ routine_id: "d3", state: "next", picked: true });
  });

  it("sets already ticked today win over a pick", () => {
    const doing = nextInRotation(routines, { day: "2026-11-24", routine_id: "d2" }, "2026-11-24");
    expect(withPick(doing, routines, "rest")).toMatchObject({ routine_id: "d2", state: "doing", picked: false });
  });

  it("ignores a pick of a routine that no longer exists", () => {
    expect(withPick(planned, routines, "gone")).toMatchObject({ routine_id: "d1", picked: false });
  });
});
