/* Pedestrian counting (Space Syntax window) — numbers over the gates + heat along the network + gate card.
 *
 * Loaded before app.js; createPedestrianCounts() is called from createMapLibreBlock() for a layer of
 * type "counts" and uses app.js globals (h, resolveUrl) at call time.
 *
 * Data (tools/build_pedestrian_counts.py):
 *   config.url      one Point per gate (all years, common names), keys c16_WD2_PM_all (2016) and the other 2016 slots,
 *                   c25_all / c25_veh, c26_all / c26_veh, all PER HOUR, point2025 / point2026 (number in the model), years "2016, 2025"
 *   config.heatUrl  short network pieces, `g` = "gateIndex:metres,…" within the FC's heatRadius
 *
 * The heat geometry is loaded once; each piece keeps its HEAT_K nearest gates (g0..g2 / d0..d2) and a switch only
 * swaps the 120 gate values inside the paint expressions — no setData / feature-state per piece.
 */
"use strict";

// One view per year: workday, 16–17. 2016 = Workday 2 pedestrians only; 2025 / 2026 = pedestrians or vehicles.
const COUNT_KEY_2016 = "c16_WD2_PM_all";
const COUNT_YEARS = ["2016", "2025", "2026"];
const COUNT_MEASURES = [["all", "Pedestrians"], ["veh", "Vehicles"]];
const COUNT_RAMP = ["#FFF1A8", "#FFD500", "#F7A21B", "#EE5A14", "#E3262A", "#8C1018"];
const HOUR_BREAKS = { all: [0, 50, 100, 200, 400, 800], veh: [0, 50, 150, 300, 600, 1200] };   // per hour, one scale for all years
const COUNT_NO_DATA = "#FFFFFF";
const HEAT_K = 3;   // gates mixed per heat piece (nearest first)

function createPedestrianCounts(map, config, { visible, toolsBody }) {
  const P = `${config.id}__`;
  const ids = { heat: P + "heat", pts: P + "pts", lbl: P + "lbl" };
  const layerIds = [ids.heat, ids.pts, ids.lbl];
  const st = { year: "2016", measure: "all", numbers: true, heat: true, on: !!visible, sel: null };
  let gates = null, R = 150;
  const yearsOf = (p) => String(p.years || "2016");
  const inYear = (p) => yearsOf(p).includes(st.year);

  // ---------------------------------------------------------------- value of a gate for the current selection
  const lookup = (p, year = st.year, measure = st.measure) =>
    (year === "2016" ? p[COUNT_KEY_2016] : p[`c${year.slice(2)}_${measure}`]) ?? null;
  const breaks = () => HOUR_BREAKS[st.measure];
  const colorExpr = (get) => {
    const br = breaks(), ramp = COUNT_RAMP;
    return ["case", ["==", ["typeof", get], "number"],
      ["interpolate", ["linear"], get, ...br.flatMap((b, i) => [b, ramp[i]])], COUNT_NO_DATA];
  };
  const V_PT = ["get", "v"];
  // heat piece: colour = distance-weighted mix of its gates, fade = distance to the nearest gate that has a value.
  // vals / has = literal arrays indexed by gate (+1 dummy slot for pieces with fewer than HEAT_K gates).
  const heatExprs = (vals) => {
    const has = vals.map((v) => (v == null ? 0 : 1)).concat(0), val = vals.map((v) => v ?? 0).concat(0);
    const at = (arr, i) => ["at", ["get", "g" + i], ["literal", arr]];
    const near = (i, p) => ["^", ["-", 1, ["/", ["get", "d" + i], R]], p];
    const ks = [...Array(HEAT_K).keys()];
    const w = ks.map((i) => ["*", at(has, i), near(i, 2)]);
    const v = ["/", ["+", ...ks.map((i) => ["*", w[i], at(val, i)])], ["max", ["+", ...w], 1e-9]];
    return { color: colorExpr(v), opacity: ["*", 0.9, ["max", ...ks.map((i) => ["*", at(has, i), near(i, 0.8)])]] };
  };
  const fmt = (v) => (v == null ? "–" : String(Math.round(v * 10) / 10));

  // ---------------------------------------------------------------- map layers
  const vis = (on) => (on ? "visible" : "none");
  function addLayers() {
    map.addSource(ids.heat, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource(ids.pts, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: ids.heat, type: "line", source: ids.heat,
      layout: { visibility: vis(st.on && st.heat), "line-cap": "butt" },   // round caps bead up where pieces overlap
      paint: {
        "line-color": COUNT_NO_DATA,
        "line-opacity": 0,
        "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 13, 2.5, 16, 7, 18.5, 18],
      },
    });
    map.addLayer({
      id: ids.pts, type: "circle", source: ids.pts, layout: { visibility: vis(st.on) },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 17, 7],
        "circle-color": colorExpr(V_PT),
        "circle-stroke-color": ["case", ["==", ["typeof", ["get", "v"]], "number"], "#0D0D0D", "#8A8A8A"],
        "circle-stroke-width": ["case", ["get", "sel"], 3, 1],
      },
    });
    map.addLayer({
      id: ids.lbl, type: "symbol", source: ids.pts, layout: {
        visibility: vis(st.on && st.numbers),
        "text-field": ["get", "label"], "text-font": ["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 14],
        "text-offset": [0.7, 0], "text-anchor": "left",   // right of the point: the gate name (own layer) sits above it
        "text-allow-overlap": false,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "v"], -1e6]],   // big numbers win when labels collide
      },
      paint: { "text-color": "#0D0D0D", "text-halo-color": "#FFFFFF", "text-halo-width": 1.8 },
    });
    map.on("click", ids.pts, (e) => { if (!map.__drawing && e.features && e.features[0]) showCard(e.features[0].properties.gate); });
    map.on("mouseenter", ids.pts, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", ids.pts, () => { map.getCanvas().style.cursor = ""; });
  }

  function repaint() {
    if (!gates || !map.getLayer(ids.pts)) return;
    if (st.year === "2016") st.measure = "all";   // vehicles were not counted in 2016
    const vals = gates.features.map((f) => lookup(f.properties));
    map.getSource(ids.pts).setData({ type: "FeatureCollection", features: gates.features.flatMap((f, i) => inYear(f.properties) ? [{
      type: "Feature", id: i, geometry: f.geometry,
      properties: { gate: f.properties.gate, v: vals[i], label: fmt(vals[i]), sel: f.properties.gate === st.sel },
    }] : []) });
    // heat: colour = distance-weighted mix of the gates within R, fade = distance to the nearest one
    const he = heatExprs(vals);
    map.setPaintProperty(ids.heat, "line-color", he.color);
    map.setPaintProperty(ids.heat, "line-opacity", he.opacity);
    map.setPaintProperty(ids.pts, "circle-color", colorExpr(V_PT));
    syncVisibility();
    renderControls();
    if (st.sel) showCard(st.sel, false);
  }

  function syncVisibility() {
    if (!map.getLayer(ids.pts)) return;
    map.setLayoutProperty(ids.heat, "visibility", vis(st.on && st.heat));
    map.setLayoutProperty(ids.pts, "visibility", vis(st.on));
    map.setLayoutProperty(ids.lbl, "visibility", vis(st.on && st.numbers));
  }

  // ---------------------------------------------------------------- left sidebar: switches under the layer row
  const controls = h("div", "cnt-panel", { hidden: !st.on });
  function seg(label, options, key, disabled = () => false) {
    const row = h("div", "cnt-row");
    const l = h("div", "cnt-label"); l.textContent = label;
    const box = h("div", "cnt-seg");
    for (const [v, t, title] of options) {
      const b = h("button", st[key] === v ? "active" : null, { type: "button", title: title || "" });
      b.textContent = t;
      b.disabled = disabled(v);
      b.addEventListener("click", () => { st[key] = v; repaint(); });
      box.append(b);
    }
    row.append(l, box);
    return row;
  }
  function renderControls() {
    controls.innerHTML = "";
    controls.append(
      seg("Year", COUNT_YEARS.map((y) => [y, y]), "year"),
      seg("Count", COUNT_MEASURES, "measure", (v) => st.year === "2016" && v === "veh"),
    );
    const show = h("div", "cnt-row cnt-checks");
    for (const [key, t] of [["numbers", "Numbers"], ["heat", "Heat on streets"]]) {
      const lab = h("label", "cnt-check");
      const cb = h("input", null, { type: "checkbox" }); cb.checked = st[key];
      cb.addEventListener("change", () => { st[key] = cb.checked; syncVisibility(); });
      const s = h("span"); s.textContent = t;
      lab.append(cb, s); show.append(lab);
    }
    const n = h("div", "cnt-note");
    n.textContent = st.year === "2016" ? "2016 · Workday 2 · 16–17 · per hour (15-min count × 4). 48 gates without that count show Workday 1."
      : `${st.year} · Workday · 16–17 · per hour.`;
    controls.append(show, legendBar(), n);
  }
  function legendBar() {
    const wrap = h("div", "cnt-legend");
    const br = breaks(), ramp = COUNT_RAMP;
    const bar = h("div", "cnt-legend-bar");
    bar.style.background = `linear-gradient(to right, ${ramp.join(", ")})`;
    const ticks = h("div", "cnt-legend-ticks");
    for (const b of br) { const t = h("span"); t.textContent = b + (b === br[br.length - 1] ? "+" : ""); ticks.append(t); }
    const cap = h("div", "cnt-note");
    cap.textContent = `${st.measure === "veh" ? "Vehicles" : "People"} per hour · white = not counted`;
    wrap.append(bar, ticks, cap);
    return wrap;
  }

  // ---------------------------------------------------------------- right toolbar: card of one gate
  const card = h("div", "tools-section cnt-card", { hidden: true });
  toolsBody.prepend(card);
  function showCard(name, scroll = true) {
    const f = gates && gates.features.find((x) => x.properties.gate === name);
    if (!f) return;
    const p = f.properties;
    const prev = st.sel; st.sel = name;
    card.innerHTML = "";
    const head = h("div", "cnt-card-head");
    const title = h("div", "tools-label"); title.textContent = `Counting gate ${name}`;
    const close = h("button", "cnt-close", { type: "button", title: "Close" }); close.textContent = "×";
    close.addEventListener("click", () => { card.hidden = true; st.sel = null; repaint(); });
    head.append(title, close);
    card.append(head);

    const cur = lookup(p);
    const vals = gates.features.filter((x) => inYear(x.properties)).map((x) => lookup(x.properties)).filter((v) => v != null).sort((a, b) => b - a);
    const big = h("div", "cnt-big");
    const bigV = h("span", "cnt-big-v"); bigV.textContent = fmt(cur);
    const bigT = h("span", "cnt-big-t");
    const mName = COUNT_MEASURES.find((m) => m[0] === st.measure)[1];
    bigT.textContent = `${st.year} · Workday · 16–17 · ${mName} / h`
      + (cur != null ? ` · rank ${vals.indexOf(cur) + 1} of ${vals.length}` : "");
    big.append(bigV, bigT);
    card.append(big);

    // all years of this gate: value of each year + the number the point has in that year's model
    const t = h("table", "cnt-table");
    const hr = h("tr");
    for (const name of ["Year", "No. in model", "Pedestrians", "Vehicles"]) { const th = h("th"); th.textContent = name; hr.append(th); }
    t.append(hr);
    const in16Filled = (p.filled || "").includes("WD2_PM_all:WD1");
    for (const y of COUNT_YEARS) {
      const on = yearsOf(p).includes(y);
      const tr = h("tr");
      const th = h("th"); th.textContent = y; tr.append(th);
      const cells = [on ? (y === "2016" ? name : p[`point${y}`] ?? "–") : "–", on ? fmt(lookup(p, y, "all")) : "–", on && y !== "2016" ? fmt(lookup(p, y, "veh")) : "–"];
      cells.forEach((c, i) => {
        const td = h("td"); td.textContent = String(c);
        if (y === "2016" && i === 1 && in16Filled && on) { td.classList.add("filled"); td.textContent += "*"; td.title = "Workday 1: no Workday 2 count at this gate"; }
        if (y === st.year && i === (st.measure === "veh" ? 2 : 1)) td.classList.add("cur");
        tr.append(td);
      });
      t.append(tr);
    }
    const note = h("div", "tools-note");
    note.textContent = "Workday, 16–17, per hour. 2016: Workday 2, 15-min count × 4. * = Workday 1, no Workday 2 count here. – = no count.";
    card.append(t, note);
    card.hidden = false;
    if (prev !== name) repaint();
    if (scroll) card.scrollIntoView({ block: "nearest" });
  }

  function setVisible(v) {
    st.on = v;
    controls.hidden = !v;
    if (!v) { card.hidden = true; st.sel = null; }
    if (gates) repaint(); else syncVisibility();
  }

  // ---------------------------------------------------------------- load
  addLayers();
  renderControls();
  Promise.all([fetch(resolveUrl(config.url)).then((r) => r.json()), fetch(resolveUrl(config.heatUrl)).then((r) => r.json())])
    .then(([g, hfc]) => {
      gates = g; R = hfc.heatRadius || R;
      const dummy = g.features.length;
      map.getSource(ids.heat).setData({ type: "FeatureCollection", features: hfc.features.map((f) => {
        const near = f.properties.g.split(",").map((s) => s.split(":").map(Number)).sort((a, b) => a[1] - b[1]);
        const props = {};
        for (let i = 0; i < HEAT_K; i++) { const [gi, d] = near[i] || [dummy, R]; props["g" + i] = gi; props["d" + i] = d; }
        return { type: "Feature", geometry: f.geometry, properties: props };
      }) });
      repaint();
    })
    .catch((err) => console.error("[counts] failed to load:", err));

  return { layerIds, setVisible, controls, showCard };
}
