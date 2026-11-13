/**
 * ReliCapGrid's files, as cimoxide's harness (`scripts/relicapgrid/test_use_cases.py`) groups them
 * per use case. The dataset is not part of this repository: its root is `$RELICAPGRID_DIR`, else
 * cimoxide's submodule beside this checkout; without it, the acceptance tests skip.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(process.env.RELICAPGRID_DIR ?? join(import.meta.dirname, '../../../../cimoxide/relicapgrid'), 'Instance');
export const PRESENT = existsSync(join(ROOT, 'Svedala'));

/** The XML files of a directory under the instance whose names match `named`, sorted, as a folder gives them. */
function dir(path: string, named = /\.xml$/i): string[] {
  const at = join(ROOT, path);
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((f) => f.toLowerCase().endsWith('.xml') && named.test(f))
    .sort()
    .map((f) => join(at, f));
}

export const AREAS = ['Belgovia', 'Britheim', 'DC-Espheim-Svedala', 'DC-Nordheim-Galia', 'Espheim', 'Galia', 'Nordheim', 'Portheim', 'Svedala'];
export const grid = (...areas: string[]) => areas.flatMap((a) => dir(`${a}/Grid/cimxml`));
export const nc = (...areas: string[]) => areas.flatMap((a) => dir(`${a}/NetworkCode/cimxml`));
export const COMMON = [...dir('commonData/Grid/cimxml'), ...dir('commonData/NetworkCode/cimxml')];
export const BOUNDARY = dir('boundaryData/Grid/cimxml');
/** An IGM with its network codes and the common data. */
export const area = (a: string) => [...grid(a), ...nc(a), ...COMMON];
export const ALL_NC = [...nc(...AREAS, 'Jotunheim'), ...dir('Jotunheim/NetworkCode')];
export const ALL_GRID = grid(...AREAS);

/**
 * The CGM as ReliCapGrid's CI assembles it, and gridoxide's tests pin: every IGM's EQ and updated
 * SSH (Jotunheim's change set), Jotunheim's topology and state, the boundary and the common data.
 */
export const CGM = [
  ...dir('Jotunheim/ChangeSet/cimxml'),
  ...dir('Jotunheim/Grid/cimxml', /_SV_/),
  ...dir('Jotunheim/Grid/cimxml', /_TP_/),
  ...AREAS.flatMap((a) => dir(`${a}/Grid/cimxml`, /_EQ_/)),
  ...BOUNDARY,
  ...dir('commonData/Grid/cimxml'),
];
/** Every area's contingencies. */
export const CO = [...AREAS, 'Jotunheim'].flatMap((a) => dir(`${a}/NetworkCode/cimxml`, /_CO.*\.xml$/));
/** The SAR ReliCapGrid supplies, Jotunheim's. */
export const SUPPLIED_SAR = join(ROOT, 'Jotunheim/NetworkCode/2D_SAR_1030Z_Jotunheim.xml');

/** CD_UC1's: every dataset but the grid situations and the version dependency. */
export const EVERYTHING = [...COMMON, ...BOUNDARY, ...ALL_GRID, ...ALL_NC].filter(
  (f, i, all) => all.indexOf(f) === i && !/GridSituation|Dataset_version_dependency/.test(f),
);
/** RD_UC1's: every network code dataset, and the reference data. */
export const REFERENCE = [...ALL_NC, ...dir('referenceData/NetworkCode/cimxml')];

/** ER_UC1's: the area's grid and network codes, the common data and the boundary. */
export const withBoundary = (a: string) => [...area(a), ...BOUNDARY];
