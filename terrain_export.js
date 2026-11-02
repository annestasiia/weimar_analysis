/* Terrain in the 3DM export: the Terrain mesh layer + heights for "Place on terrain".
 *
 * Loaded before app.js; called from build3dmExport() and uses its globals (manifest, resolveUrl, _ptInPoly) at call time.
 *
 * Data: web/terrain/export/weimar_dgm_<step>m.bin (tools/build_dgm_export_grids.py), manifest terrainDem.exportGrid.
 * Coordinates here are EPSG:25832, z = metres above sea level. All heights come from the exported mesh itself (the same
 * triangles, diagonal SW-NE), not from the 1 m DGM: that way a building cannot hang above the mesh in the file.
 */
"use strict";

const TERRAIN_EST = { bytesPerTriangle: 26, msPerTriangle: 0.04 };   // measured: 11 M triangles = 266 MB, 454 s
const TERRAIN_TILE_CELLS = 500;     // cells per side of one Rhino mesh: large areas must fit into the 100 MB .3dm parts
const _terrainGrids = new Map();

function loadTerrainGrid(step) {
  if (!_terrainGrids.has(step)) {
    const cfg = manifest.terrainDem.exportGrid, g = cfg.grids[String(step)];
    _terrainGrids.set(step, fetch(resolveUrl(g.url)).then((r) => {
      if (!r.ok) throw new Error(`could not fetch terrain grid: HTTP ${r.status}`);
      return r.arrayBuffer();
    }).then((buf) => ({
      step, cols: g.cols, rows: g.rows, noData: cfg.noData, z: new Uint16Array(buf),
      x0: cfg.ulx + step / 2,                 // E of column 0
      y0: cfg.uly - (g.rows - 0.5) * step,    // N of the southern row
    })));
  }
  return _terrainGrids.get(step);
}

/** Height of a node; column i from the west, row j from the SOUTH. null = no data / outside. */
function _nodeZ(g, i, j) {
  if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return null;
  const v = g.z[(g.rows - 1 - j) * g.cols + i];
  return v === g.noData ? null : v / 100;
}

/** Height of the mesh surface at (e, n); null where the mesh has no cell. */
function terrainHeightAt(g, e, n) {
  const p = (e - g.x0) / g.step, q = (n - g.y0) / g.step;
  if (p < 0 || q < 0 || p > g.cols - 1 || q > g.rows - 1) return null;   // no extrapolation past the grid
  const i = Math.min(Math.floor(p), g.cols - 2), j = Math.min(Math.floor(q), g.rows - 2);
  const sw = _nodeZ(g, i, j), se = _nodeZ(g, i + 1, j), ne = _nodeZ(g, i + 1, j + 1), nw = _nodeZ(g, i, j + 1);
  if (sw === null || se === null || ne === null || nw === null) return null;
  const u = p - i, v = q - j;
  return v <= u ? sw + u * (se - sw) + v * (ne - se) : sw + v * (nw - sw) + u * (ne - nw);
}

/** Parameters 0..1 along a-b where the segment crosses a mesh edge (columns, rows, diagonals): between them the surface is straight. */
function _meshCrossings(g, a, b) {
  const p0 = (a[0] - g.x0) / g.step, q0 = (a[1] - g.y0) / g.step, p1 = (b[0] - g.x0) / g.step, q1 = (b[1] - g.y0) / g.step;
  const ts = [0, 1];
  for (const [f0, f1] of [[p0, p1], [q0, q1], [p0 - q0, p1 - q1]]) {
    if (f0 === f1) continue;
    for (let k = Math.ceil(Math.min(f0, f1)); k <= Math.floor(Math.max(f0, f1)); k++) ts.push((k - f0) / (f1 - f0));
  }
  return ts.sort((x, y) => x - y);
}

/** Lowest point of the mesh under a footprint (rings in EPSG:25832: outer + courtyards): walls + the nodes inside. null = no terrain at all. */
function terrainMinUnder(g, rings) {
  let min = Infinity;
  const take = (z) => { if (z !== null && z < min) min = z; };
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      for (const t of _meshCrossings(g, a, b)) take(terrainHeightAt(g, a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])));
    }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rings[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (let i = Math.ceil((x0 - g.x0) / g.step); i <= Math.floor((x1 - g.x0) / g.step); i++) {
    for (let j = Math.ceil((y0 - g.y0) / g.step); j <= Math.floor((y1 - g.y0) / g.step); j++) {
      const x = g.x0 + i * g.step, y = g.y0 + j * g.step;
      if (_ptInPoly(rings[0], x, y) && !rings.slice(1).some((h) => _ptInPoly(h, x, y))) take(_nodeZ(g, i, j));
    }
  }
  return min === Infinity ? null : min;
}

/** Line [[e, n]…] on the mesh: a vertex at every mesh edge it crosses. Gaps take the nearest known height; null = no terrain on the whole line. */
function terrainDrapeLine(g, pts) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    for (const t of _meshCrossings(g, a, b)) {
      if (k > 0 && t === 0) continue;
      const e = a[0] + t * (b[0] - a[0]), n = a[1] + t * (b[1] - a[1]);
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - e) < 1e-6 && Math.abs(last[1] - n) < 1e-6) continue;
      out.push([e, n, terrainHeightAt(g, e, n)]);
    }
  }
  if (!out.some((p) => p[2] !== null)) return null;
  for (let k = 1; k < out.length; k++) if (out[k][2] === null) out[k][2] = out[k - 1][2];
  for (let k = out.length - 2; k >= 0; k--) if (out[k][2] === null) out[k][2] = out[k + 1][2];
  return out;
}

/**
 * Mesh tiles of the export area (ring in EPSG:25832). A cell belongs to the area when a corner is inside it or it holds a
 * vertex of the ring, and it has heights at all four corners. -> [{ i0, j0, cells: [[i, j]…] }]
 */
function terrainTiles(g, ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.step)), i1 = Math.min(g.cols - 1, Math.ceil((x1 - g.x0) / g.step));
  const j0 = Math.max(0, Math.floor((y0 - g.y0) / g.step)), j1 = Math.min(g.rows - 1, Math.ceil((y1 - g.y0) / g.step));
  const tiles = new Map();
  if (i0 >= i1 || j0 >= j1) return [];
  const w = i1 - i0 + 1;
  const inside = new Uint8Array(w * (j1 - j0 + 1));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (_ptInPoly(ring, g.x0 + i * g.step, g.y0 + j * g.step)) inside[(j - j0) * w + i - i0] = 1;
  }
  const holdsVertex = new Set(ring.map(([x, y]) => `${Math.floor((x - g.x0) / g.step)},${Math.floor((y - g.y0) / g.step)}`));
  const at = (i, j) => inside[(j - j0) * w + i - i0];
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    if (!(at(i, j) || at(i + 1, j) || at(i, j + 1) || at(i + 1, j + 1) || holdsVertex.has(`${i},${j}`))) continue;
    if (_nodeZ(g, i, j) === null || _nodeZ(g, i + 1, j) === null || _nodeZ(g, i, j + 1) === null || _nodeZ(g, i + 1, j + 1) === null) continue;
    const key = `${Math.floor(i / TERRAIN_TILE_CELLS)},${Math.floor(j / TERRAIN_TILE_CELLS)}`;
    if (!tiles.has(key)) tiles.set(key, { key, cells: [] });
    tiles.get(key).cells.push([i, j]);
  }
  return [...tiles.values()];
}

/** One tile -> Rhino mesh. Double-precision vertices: without a local origin float32 would round UTM to half a metre. */
function terrainTileMesh(rhino, g, tile, ox, oy) {
  const mesh = new rhino.Mesh();
  const verts = mesh.vertices(), faces = mesh.faces();
  verts.useDoublePrecisionVertices = true;
  const index = new Map();
  const node = (i, j) => {
    const k = j * g.cols + i;
    let n = index.get(k);
    if (n === undefined) {
      n = index.size; index.set(k, n);
      verts.add(g.x0 + i * g.step - ox, g.y0 + j * g.step - oy, _nodeZ(g, i, j));
    }
    return n;
  };
  for (const [i, j] of tile.cells) {
    const sw = node(i, j), se = node(i + 1, j), ne = node(i + 1, j + 1), nw = node(i, j + 1);
    faces.addTriFace(sw, se, ne);
    faces.addTriFace(sw, ne, nw);
  }
  mesh.normals().computeNormals();
  mesh.compact();
  return mesh;
}
