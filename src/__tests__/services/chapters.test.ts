import { describe, expect, it } from "vitest";
import { buildChapters, km, type MonthPlace } from "../../services/chapters";

const KTM = { lat: 27.754, lng: 85.346 };
const COLLEGE = { lat: 27.674, lng: 85.339 };
const ARL = { lat: 38.86, lng: -77.064 };
const GWU = { lat: 38.899, lng: -77.048 };
const KL = { lat: 3.14, lng: 101.69 };

function row(mo: string, at: { lat: number; lng: number }, hours: number, n: number, name: string, city = "Kathmandu", country = "Nepal"): MonthPlace {
  return { mo, key: `${at.lat.toFixed(3)},${at.lng.toFixed(3)}`, hours, n, lat: at.lat, lng: at.lng, name, city, country };
}

function months(from: string, count: number) {
  const [y, m] = from.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return d.toISOString().slice(0, 7);
  });
}

describe("chapters", () => {
  const ktm = months("2023-01", 12).flatMap((mo) => [
    row(mo, KTM, 500, 30, "Golphutar Main Sadak", "Nepal"),
    row(mo, COLLEGE, 80, 20, "Kathford International College"),
  ]);
  const dc = months("2024-08", 6).flatMap((mo) => [
    row(mo, ARL, 450, 25, "RiverHouse Apartments", "Arlington", "United States"),
    row(mo, GWU, 60, 15, "GWU", "Washington", "United States"),
  ]);

  it("splits a life into the homes it had, with where the days went", () => {
    const chapters = buildChapters([...ktm, ...dc], [], [], []);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toMatchObject({ start: "2023-01", end: "2023-12", months: 12 });
    expect(chapters[0].home.name).toBe("Golphutar Main Sadak");
    expect(chapters[0].anchor?.name).toBe("Kathford International College");
    expect(chapters[1].home.name).toBe("RiverHouse Apartments");
    expect(chapters[1].anchor?.name).toBe("GWU");
  });

  it("uses a real city when the country leaked into the city field", () => {
    expect(buildChapters(ktm, [], [], [])[0].city).toBe("Kathmandu");
  });

  it("folds a short trip into the chapter around it", () => {
    const trip = [row("2023-06", KL, 900, 5, "Kuala Lumpur", "Kuala Lumpur", "Malaysia")];
    const withTrip = [...ktm.filter((r) => r.mo !== "2023-06"), ...trip];
    const chapters = buildChapters(withTrip, [], [], []);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].home.name).toBe("Golphutar Main Sadak");
  });

  it("adds up visits, new places and how you got around", () => {
    const chapters = buildChapters(ktm, [{ mo: "2023-01", n: 40 }, { mo: "2023-02", n: 35 }], [{ mo: "2023-03", n: 7 }],
      [{ mo: "2023-01", mode: "motorcycling", m: 120_000 }, { mo: "2023-02", mode: "walking", m: 8_000 }, { mo: "2023-05", mode: "flying", m: 700_000 }]);
    expect(chapters[0]).toMatchObject({ visits: 75, newPlaces: 7, km: 128 });
    expect(chapters[0].modes[0]).toEqual({ mode: "flying", km: 700 });
    expect(chapters[0].modes[1]).toEqual({ mode: "motorcycling", km: 120 });
  });

  it("measures distance on the globe", () => {
    expect(km(KTM, ARL)).toBeGreaterThan(12_000);
    expect(km(KTM, COLLEGE)).toBeLessThan(10);
  });
});
