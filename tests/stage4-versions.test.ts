import { describe, expect, it } from "vitest";
import { STAGE4_FLAGS, stage4Enabled, stage4FlagMode } from "../src/lib/agentMission/stage4/flags";
import { deriveVersion, diffVersions, firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { tiktokWorld } from "./helpers/round11Worlds";

/**
 * STAGE 4 (docs/STAGE-4.md), FILE VERSIONS: a delivered file is version 1; every later change makes a NEW version from the old one, and the old one is never changed (it is frozen and its
 * digest stays). The file is the one the current code builds from the stored real rows of M12 (msn_5851abc92a1e6645a9cd, tests/helpers/round11Worlds.ts `tiktokWorld`).
 */
describe("flags: every Stage 4 flag is OFF when it is not set", () => {
  it("only «on» and «test» turn one on", () => {
    for (const name of STAGE4_FLAGS) {
      expect(stage4FlagMode(name, {})).toBe("off");
      expect(stage4Enabled(name, true, {})).toBe(false);
      expect(stage4Enabled(name, true, { [name]: "test" })).toBe(true);
      expect(stage4Enabled(name, false, { [name]: "test" })).toBe(false);
      expect(stage4Enabled(name, false, { [name]: "on" })).toBe(true);
    }
    expect([...STAGE4_FLAGS].sort()).toEqual(["DIGER_STAGE4_APPROVAL", "DIGER_STAGE4_EDITS", "DIGER_STAGE4_REVIEW", "DIGER_STAGE4_VERSIONS"]);
  });
});

describe("versions", () => {
  it("version 1 is the delivered file: its data sheets (not the summary), headers and rows by their ids, with a digest", async () => {
    const { cells } = await tiktokWorld();
    const v1 = firstVersionFromCells({ missionId: "msn_v", cells, createdAt: "2026-11-04T10:00:00.000Z" });
    expect(v1.version).toBe(1);
    expect(v1.parent).toBeNull();
    expect(v1.reason).toBe("delivery");
    expect(v1.sheets.map((s) => s.nameAr)).toEqual(Object.keys(cells).filter((n) => n !== "ملخص المهمة"));
    const videos = v1.sheets[0];
    expect(videos.rows.length).toBe(cells[videos.nameAr].length - 1);
    expect(videos.rows.map((r) => r.id)).toEqual(cells[videos.nameAr].slice(1).map((r) => r[cells[videos.nameAr][0].indexOf("المعرّف")]));
    expect(v1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(v1) && Object.isFrozen(v1.sheets[0].rows[0].cells)).toBe(true);
  });
  it("a new version is made FROM the old one: the old one is not changed (same JSON, same digest), the new one points to it", async () => {
    const { cells } = await tiktokWorld();
    const v1 = firstVersionFromCells({ missionId: "msn_v", cells, createdAt: "2026-11-04T10:00:00.000Z" });
    const before = JSON.stringify(v1);
    const v2 = deriveVersion(v1, (sheets) => sheets.map((s, i) => (i === 0 ? { ...s, rows: s.rows.map((r, k) => (k === 0 ? { ...r, cells: r.cells.map((c, j) => (j === 0 ? `${c} (مصحح)` : c)) } : r)) } : s)), { reason: "edit", createdAt: "2026-11-04T11:00:00.000Z" });
    expect(JSON.stringify(v1)).toBe(before);
    expect([v2.version, v2.parent, v2.reason]).toEqual([2, 1, "edit"]);
    expect(v2.digest).not.toBe(v1.digest);
    const d = diffVersions(v1, v2);
    expect(d).toMatchObject({ rowsAdded: 0, rowsRemoved: 0, rowsChanged: 1, cellsChanged: 1, columnsAdded: [], columnsRemoved: [] });
  });
  it("a change that changes nothing still makes a version with the SAME digest (the digest is of the content only)", async () => {
    const { cells } = await tiktokWorld();
    const v1 = firstVersionFromCells({ missionId: "msn_v", cells, createdAt: "2026-11-04T10:00:00.000Z" });
    const v2 = deriveVersion(v1, (s) => s, { reason: "edit", createdAt: "2026-11-04T12:00:00.000Z" });
    expect(v2.digest).toBe(v1.digest);
    expect(diffVersions(v1, v2)).toMatchObject({ rowsAdded: 0, rowsRemoved: 0, rowsChanged: 0, cellsChanged: 0 });
  });
  it("the storage path of a version is create-only and ordered (a proposal: no table, no migration)", () => {
    expect(versionPathOf(1)).toBe("versions/v0001.json");
    expect(versionPathOf(12)).toBe("versions/v0012.json");
  });
  it("a changer that mutates the old version is stopped (it is frozen)", async () => {
    const { cells } = await tiktokWorld();
    const v1: FileVersion = firstVersionFromCells({ missionId: "msn_v", cells, createdAt: "2026-11-04T10:00:00.000Z" });
    expect(() => deriveVersion(v1, (sheets) => { (sheets[0].rows as unknown as unknown[]).pop(); return sheets; }, { reason: "edit", createdAt: "x" })).toThrow();
  });
});
