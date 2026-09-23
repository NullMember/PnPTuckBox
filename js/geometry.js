// Box dielines. Each style describes its flat layout as panel polygons (mm,
// origin top-left, y down). Fold lines are derived automatically — an edge
// shared by two panels is a fold — and every other edge is a cut, chained
// into closed paths. So styles only need to get the panel shapes right.

const ARC_STEPS = 10;

// Points along a circular arc (angles in degrees, y down; excludes the start point).
function arc(cx, cy, r, fromDeg, toDeg) {
    const pts = [];
    for (let i = 1; i <= ARC_STEPS; i++) {
        const a = ((fromDeg + ((toDeg - fromDeg) * i) / ARC_STEPS) * Math.PI) / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
}

function rect(x, y, w, h) {
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- Fold / cut extraction ---------------------------------------------------------

const key = ([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`;
const edgeKey = (a, b) => [key(a), key(b)].sort().join('|');

function extractLines(panels) {
    const count = new Map();
    const edges = [];
    panels.forEach((p) => {
        p.poly.forEach((a, i) => {
            const b = p.poly[(i + 1) % p.poly.length];
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return;
            const k = edgeKey(a, b);
            count.set(k, (count.get(k) || 0) + 1);
            edges.push({ a, b, k });
        });
    });

    const folds = [];
    const seenFold = new Set();
    const cutEdges = [];
    edges.forEach((e) => {
        if (count.get(e.k) > 1) {
            if (!seenFold.has(e.k)) { seenFold.add(e.k); folds.push([e.a, e.b]); }
        } else {
            cutEdges.push(e);
        }
    });

    // Chain cut edges end-to-end into closed loops (one per piece outline).
    const byStart = new Map();
    cutEdges.forEach((e) => {
        [[e.a, e.b], [e.b, e.a]].forEach(([p, q]) => {
            const k = key(p);
            if (!byStart.has(k)) byStart.set(k, []);
            byStart.get(k).push({ e, to: q });
        });
    });
    const used = new Set();
    const cuts = [];
    cutEdges.forEach((start) => {
        if (used.has(start)) return;
        used.add(start);
        const loop = [start.a, start.b];
        let cur = start.b;
        for (let guard = 0; guard < cutEdges.length; guard++) {
            const next = (byStart.get(key(cur)) || []).find((c) => !used.has(c.e));
            if (!next) break;
            used.add(next.e);
            if (key(next.to) === key(loop[0])) { cur = null; break; }
            loop.push(next.to);
            cur = next.to;
        }
        cuts.push(loop);
    });
    return { folds, cuts };
}

function finishPiece(name, panels) {
    let x1 = -Infinity, y1 = -Infinity, x0 = Infinity, y0 = Infinity;
    panels.forEach((p) => p.poly.forEach(([x, y]) => {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }));
    // Normalise so the piece starts at (0, 0).
    panels.forEach((p) => { p.poly = p.poly.map(([x, y]) => [x - x0, y - y0]); });
    panels.forEach((p) => {
        const xs = p.poly.map((q) => q[0]), ys = p.poly.map((q) => q[1]);
        p.box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    });
    return { name, width: x1 - x0, height: y1 - y0, panels, ...extractLines(panels) };
}

// ---- Dimensions ------------------------------------------------------------------------

/**
 * cfg: { cardW, cardH, thickness, clearance, paper } (mm)
 * Inner size of the space for the deck, and panel sizes (inner + paper).
 */
function boxDims(cfg) {
    const W = cfg.cardW + cfg.clearance;
    const H = cfg.cardH + cfg.clearance;
    const D = cfg.thickness + cfg.clearance;
    const t = cfg.paper;
    return { W, H, D, t, pw: W + t, ph: H + t, pd: D + t };
}

// ---- Classic tuck box (reverse tuck end) --------------------------------------------------
//
//            [tuck]
//            [lid ]  [dust]        [dust]
//   [glue]  [back ][side ][front*][side ]      * thumb notch
//            [dust]        [bottom]
//                          [tuck  ]

function tuckFlap(xa, xb, ya, depth, dir) {
    // Rounded tuck flap on edge (xa..xb, ya); dir = -1 extends up, +1 down.
    const inset = 1.5;
    const r = clamp(depth * 0.7, 3, (xb - xa) / 3);
    const yt = ya + dir * depth;
    const pts = [[xa, ya], [xa + inset, ya + dir * 2], [xa + inset, yt - dir * r]];
    if (dir < 0) {
        pts.push(...arc(xa + inset + r, yt + r, r, 180, 270));
        pts.push([xb - inset - r, yt]);
        pts.push(...arc(xb - inset - r, yt + r, r, 270, 360));
    } else {
        pts.push(...arc(xa + inset + r, yt - r, r, 180, 90));
        pts.push([xb - inset - r, yt]);
        pts.push(...arc(xb - inset - r, yt - r, r, 90, 0));
    }
    pts.push([xb - inset, ya + dir * 2], [xb, ya]);
    return pts;
}

function dustFlap(xa, xb, ya, depth, dir) {
    // Tapered flap with a 1 mm gap from neighbouring panels so it never shares
    // an edge (which would turn a cut into a fold).
    const taper = Math.min(depth * 0.35, (xb - xa) / 3);
    const yt = ya + dir * depth;
    return [[xa, ya], [xa + 1, ya + dir * 2], [xa + 1 + taper, yt], [xb - 1 - taper, yt], [xb - 1, ya + dir * 2], [xb, ya]];
}

function classicTuck(cfg) {
    const { pw, ph, pd } = boxDims(cfg);
    const g = clamp(pd * 0.8, 8, 12);        // glue flap
    const tuck = clamp(pd * 0.8, 12, 22);    // tuck-in flap depth
    const dust = clamp(pd * 0.85, 6, 25);    // dust flap depth
    const notchR = Math.min(pw * 0.18, 12);  // thumb notch radius

    const xb = g, xs1 = g + pw, xf = xs1 + pd, xs2 = xf + pw, xe = xs2 + pd;
    const y1 = tuck + pd, y2 = y1 + ph;
    const cx = xf + pw / 2;

    const front = [[xf, y1], [cx - notchR, y1], ...arc(cx, y1, notchR, 180, 0).slice(0, -1), [cx + notchR, y1], [xs2, y1], [xs2, y2], [xf, y2]];

    const panels = [
        { id: 'glue', name: 'Glue flap', glue: true, poly: [[0, y1 + 4], [g, y1], [g, y2], [0, y2 - 4]] },
        { id: 'back', name: 'Back', slot: 'back', poly: rect(xb, y1, pw, ph) },
        { id: 'side1', name: 'Side', slot: 'sideL', poly: rect(xs1, y1, pd, ph) },
        { id: 'front', name: 'Front', slot: 'front', poly: front },
        { id: 'side2', name: 'Side', slot: 'sideR', poly: rect(xs2, y1, pd, ph) },
        // The lid folds over from the back, so its art is drawn upside down in
        // the flat layout to read correctly from the front of the closed box.
        { id: 'lid', name: 'Top', slot: 'top', artRot: 180, poly: rect(xb, y1 - pd, pw, pd) },
        { id: 'tuckTop', name: 'Tuck flap', poly: tuckFlap(xb, xs1, y1 - pd, tuck, -1) },
        { id: 'dust1', name: 'Dust flap', poly: dustFlap(xs1, xf, y1, dust, -1) },
        { id: 'dust2', name: 'Dust flap', poly: dustFlap(xs2, xe, y1, dust, -1) },
        { id: 'bottom', name: 'Bottom', slot: 'bottom', poly: rect(xf, y2, pw, pd) },
        { id: 'tuckBottom', name: 'Tuck flap', poly: tuckFlap(xf, xs2, y2 + pd, tuck, 1) },
        { id: 'dust3', name: 'Dust flap', poly: dustFlap(xs1, xf, y2, dust, 1) },
        { id: 'dust4', name: 'Dust flap', poly: dustFlap(xs2, xe, y2, dust, 1) },
    ];
    return [finishPiece('Tuck box', panels)];
}

// ---- Two-piece box (tray base + slightly larger lid) ---------------------------------------
//
//   [tab][ wall ][tab]
//   [wall][floor][wall]      the deck lies flat on the floor
//   [tab][ wall ][tab]

function tray(name, w, l, h, slots) {
    const tw = Math.max(3, h * 0.85); // corner glue tab width
    const panels = [
        { id: 'floor', name: slots.floorName, slot: slots.floor, poly: rect(h, h, w, l) },
        // Walls fold away from the printed side, so their art is turned to read
        // upright once folded: the far wall upside down, side walls sideways.
        { id: 'wallTop', name: 'Wall', slot: slots.long, artRot: 180, poly: rect(h, 0, w, h) },
        { id: 'wallBottom', name: 'Wall', slot: slots.long, poly: rect(h, h + l, w, h) },
        { id: 'wallLeft', name: 'Wall', slot: slots.short, artRot: 90, poly: rect(0, h, h, l) },
        { id: 'wallRight', name: 'Wall', slot: slots.short, artRot: 270, poly: rect(h + w, h, h, l) },
        { id: 'tab1', name: 'Glue tab', glue: true, poly: [[h, 0], [h, h], [h - tw, h - 1.5], [h - tw, 1.5]] },
        { id: 'tab2', name: 'Glue tab', glue: true, poly: [[h + w, 0], [h + w + tw, 1.5], [h + w + tw, h - 1.5], [h + w, h]] },
        { id: 'tab3', name: 'Glue tab', glue: true, poly: [[h, h + l], [h, h + l + h], [h - tw, h + l + h - 1.5], [h - tw, h + l + 1.5]] },
        { id: 'tab4', name: 'Glue tab', glue: true, poly: [[h + w, h + l], [h + w + tw, h + l + 1.5], [h + w + tw, h + l + h - 1.5], [h + w, h + l + h]] },
    ];
    return finishPiece(name, panels);
}

function twoPiece(cfg) {
    const { W, H, D, t } = boxDims(cfg);
    const bw = W + 2 * t, bl = H + 2 * t, bh = D + t;
    // The lid slides over the base: its inside matches the base's outside plus a little play.
    const play = 0.5;
    const lw = bw + 2 * t + play, ll = bl + 2 * t + play;
    const lh = bh * (cfg.lidDepth / 100);
    return [
        tray('Lid', lw, ll, lh, { floor: 'lidTop', floorName: 'Lid top', long: 'lidLong', short: 'lidShort' }),
        tray('Base', bw, bl, bh, { floor: 'baseFloor', floorName: 'Base floor', long: 'baseLong', short: 'baseShort' }),
    ];
}

// ---- Sleeve / wrap ------------------------------------------------------------------------
//
//   [front][side][back][side][glue]      open at both ends

function sleeve(cfg) {
    const { pw, ph, pd } = boxDims(cfg);
    const bh = ph * (cfg.sleeveHeight / 100);
    const g = clamp(pd * 0.8, 8, 12);
    const x1 = pw, x2 = x1 + pd, x3 = x2 + pw, x4 = x3 + pd;
    const panels = [
        { id: 'front', name: 'Front', slot: 'front', poly: rect(0, 0, pw, bh) },
        { id: 'side1', name: 'Side', slot: 'sideR', poly: rect(x1, 0, pd, bh) },
        { id: 'back', name: 'Back', slot: 'back', poly: rect(x2, 0, pw, bh) },
        { id: 'side2', name: 'Side', slot: 'sideL', poly: rect(x3, 0, pd, bh) },
        { id: 'glue', name: 'Glue flap', glue: true, poly: [[x4, 0], [x4 + g, Math.min(4, bh / 4)], [x4 + g, bh - Math.min(4, bh / 4)], [x4, bh]] },
    ];
    return [finishPiece('Sleeve', panels)];
}

// ---- Public -----------------------------------------------------------------------------

const BOX_STYLES = {
    tuck: { label: 'Classic tuck box', build: classicTuck, slots: ['front', 'back', 'sideL', 'sideR', 'top', 'bottom'] },
    twoPiece: { label: 'Two-piece box', build: twoPiece, slots: ['lidTop', 'lidLong', 'lidShort', 'baseFloor', 'baseLong', 'baseShort'] },
    sleeve: { label: 'Sleeve / wrap', build: sleeve, slots: ['front', 'back', 'sideL', 'sideR'] },
};

const SLOT_LABELS = {
    front: 'Front',
    back: 'Back',
    sideL: 'Left side',
    sideR: 'Right side',
    top: 'Top (lid)',
    bottom: 'Bottom',
    lidTop: 'Lid top',
    lidLong: 'Lid long sides',
    lidShort: 'Lid short sides',
    baseFloor: 'Base floor (inside)',
    baseLong: 'Base long sides',
    baseShort: 'Base short sides',
};

function buildBox(style, cfg) {
    return BOX_STYLES[style].build(cfg);
}

if (typeof module !== 'undefined') module.exports = { buildBox, boxDims, BOX_STYLES };
