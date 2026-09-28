export const STATIONS = ["plan", "build", "review"] as const;

export type Station = (typeof STATIONS)[number];

export const STATIONS_SQL = STATIONS.map((station) => `'${station}'`).join(",");

export function isStation(value: string | null | undefined): value is Station {
  return typeof value === "string" && (STATIONS as readonly string[]).includes(value);
}
