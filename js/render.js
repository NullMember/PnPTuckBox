// Placing box pieces on paper, and drawing them: preview canvas, PDF (art as
// one raster per page + vector cut/fold lines) and SVG cut file.

const MM_TO_PT = 72 / 25.4;
const MIN_PIECE_GAP = 6; // mm between pieces sharing a page (grows with the bleed)

// ---- Page placement -------------------------------------------------------------------

// A piece on a page: x, y = top-left of its (possibly rotated) bounding box.
function placedSize(piece, rot) {
    return rot ? { w: piece.height, h: piece.width } : { w: piece.width, h: piece.height };
}

// Pieces in one row or column, each optionally turned 90°, on as few pages as
// possible. A piece that fits no page orientation is still placed, and flagged.
function layoutPages(pieces, paper, margin, bleed = 0) {
    const PIECE_GAP = Math.max(MIN_PIECE_GAP, 2 * bleed + 3);
    const aw = paper.w - 2 * margin;
    const ah = paper.h - 2 * margin;
    const fits = (s) => s.w <= aw + 0.01 && s.h <= ah + 0.01;

    // Try all pieces together (≤ 2 pieces in practice).
    const combos = [];
    const n = pieces.length;
    for (let mask = 0; mask < 1 << n; mask++) {
        const sizes = pieces.map((p, i) => placedSize(p, (mask >> i) & 1));
        const row = { w: sizes.reduce((a, s) => a + s.w, 0) + PIECE_GAP * (n - 1), h: Math.max(...sizes.map((s) => s.h)) };
        const col = { w: Math.max(...sizes.map((s) => s.w)), h: sizes.reduce((a, s) => a + s.h, 0) + PIECE_GAP * (n - 1) };
        if (fits(row)) combos.push({ mask, dir: 'row', size: row, sizes });
        if (fits(col)) combos.push({ mask, dir: 'col', size: col, sizes });
    }
    if (combos.length) {
        const c = combos[0];
        let cx = margin + (aw - c.size.w) / 2;
        let cy = margin + (ah - c.size.h) / 2;
        const items = pieces.map((piece, i) => {
            const s = c.sizes[i];
            const item = {
                piece,
                rot: (c.mask >> i) & 1,
                x: c.dir === 'row' ? cx : margin + (aw - s.w) / 2,
                y: c.dir === 'col' ? cy : margin + (ah - s.h) / 2,
                fits: true,
            };
            if (c.dir === 'row') cx += s.w + PIECE_GAP; else cy += s.h + PIECE_GAP;
            return item;
        });
        return [{ items }];
    }

    // One piece per page, in whichever orientation fits (or the better one).
    return pieces.map((piece) => {
        let rot = fits(placedSize(piece, 0)) ? 0 : fits(placedSize(piece, 1)) ? 1 : null;
        const ok = rot !== null;
        if (!ok) {
            // Neither fits: keep the orientation that overflows least.
            const over = (s) => Math.max(0, s.w - aw) + Math.max(0, s.h - ah);
            rot = over(placedSize(piece, 1)) < over(placedSize(piece, 0)) ? 1 : 0;
        }
        const s = placedSize(piece, rot);
        return { items: [{ piece, rot, x: margin + (aw - s.w) / 2, y: margin + (ah - s.h) / 2, fits: ok }] };
    });
}

// Piece coordinates -> page coordinates (mm).
function toPage(item) {
    return ([x, y]) => (item.rot ? [item.x + item.piece.height - y, item.y + x] : [item.x + x, item.y + y]);
}

// Canvas transform equivalent of toPage, for drawing in piece coordinates.
function applyPieceTransform(ctx, item) {
    ctx.translate(item.x, item.y);
    if (item.rot) {
        ctx.translate(item.piece.height, 0);
        ctx.rotate(Math.PI / 2);
    }
}

function polyPath(points) {
    const p = new Path2D();
    points.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
}

// ---- Artwork ---------------------------------------------------------------------------

function isWhite(hex) {
    return /^#?f{6}$/i.test(hex);
}

// Draw background + panel artwork for one piece, in piece mm coordinates.
function drawPieceArt(ctx, piece, art, opts) {
    // Background: the outline filled and stroked 2 × bleed wide, which grows
    // the shape by the bleed on every side (with rounded corners).
    if (!isWhite(opts.bgColor) || opts.forceBackground) {
        ctx.save();
        ctx.fillStyle = opts.bgColor;
        ctx.strokeStyle = opts.bgColor;
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(0.01, 2 * opts.bleed);
        piece.cuts.forEach((loop) => {
            const path = polyPath(loop);
            ctx.fill(path);
            if (opts.bleed > 0) ctx.stroke(path);
        });
        ctx.restore();
    }

    piece.panels.forEach((panel) => {
        const a = panel.slot && art[panel.slot];
        if (!a) return;
        const { x, y, w, h } = panel.box;
        const rot = ((panel.artRot || 0) + (a.rot || 0)) % 360;
        const img = a.img;
        ctx.save();
        ctx.clip(polyPath(panel.poly));
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        // Cover the panel: in the rotated frame the target box is swapped for 90/270.
        const tw = rot % 180 ? h : w;
        const th = rot % 180 ? w : h;
        const s = Math.max(tw / img.width, th / img.height);
        ctx.drawImage(img, (-img.width * s) / 2, (-img.height * s) / 2, img.width * s, img.height * s);
        ctx.restore();
    });
}

// ---- Preview ---------------------------------------------------------------------------

function drawPagePreview(canvas, page, ctxInfo) {
    const { paper, art, opts, maxWidth, showLabels } = ctxInfo;
    const k = maxWidth / paper.w;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(paper.w * k * dpr);
    canvas.height = Math.round(paper.h * k * dpr);
    canvas.style.width = `${Math.round(paper.w * k)}px`;
    canvas.style.height = `${Math.round(paper.h * k)}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr * k, dpr * k);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, paper.w, paper.h);

    // Printable area
    ctx.save();
    ctx.strokeStyle = '#c9d3ff';
    ctx.lineWidth = 0.4;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(opts.margin, opts.margin, paper.w - 2 * opts.margin, paper.h - 2 * opts.margin);
    ctx.restore();

    page.items.forEach((item) => {
        ctx.save();
        applyPieceTransform(ctx, item);
        drawPieceArt(ctx, item.piece, art, opts);

        // Glue areas
        ctx.fillStyle = 'rgba(64, 192, 87, 0.28)';
        item.piece.panels.filter((p) => p.glue).forEach((p) => ctx.fill(polyPath(p.poly)));

        // Fold lines
        ctx.strokeStyle = '#2b6cb0';
        ctx.lineWidth = 0.35;
        ctx.setLineDash([2, 1.2]);
        item.piece.folds.forEach(([a, b]) => {
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
        });
        // Cut lines
        ctx.setLineDash([]);
        ctx.strokeStyle = item.fits ? '#e03131' : '#ff00aa';
        ctx.lineWidth = 0.4;
        item.piece.cuts.forEach((loop) => ctx.stroke(polyPath(loop)));

        if (showLabels) {
            // Dark text with a light halo stays readable on any artwork.
            ctx.fillStyle = 'rgba(20, 24, 40, 0.85)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineJoin = 'round';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            item.piece.panels.forEach((p) => {
                const { x, y, w, h } = p.box;
                const size = Math.min(4, Math.max(1.6, Math.min(w, h) / 5));
                ctx.font = `600 ${size}px sans-serif`;
                ctx.save();
                ctx.translate(x + w / 2, y + h / 2);
                if (h > w * 1.6 && w < 25) ctx.rotate(-Math.PI / 2);
                ctx.lineWidth = size * 0.3;
                ctx.strokeText(p.name, 0, 0);
                ctx.fillText(p.name, 0, 0);
                ctx.restore();
            });
        }
        ctx.restore();
    });
    return k;
}

// Which artwork slot is under a point (page mm)? Used for drag-and-drop.
function slotAt(page, xMm, yMm) {
    const ctx = document.createElement('canvas').getContext('2d');
    for (const item of page.items) {
        const map = toPage(item);
        for (const panel of item.piece.panels) {
            if (!panel.slot) continue;
            if (ctx.isPointInPath(polyPath(panel.poly.map(map)), xMm, yMm)) return panel.slot;
        }
    }
    return null;
}

// ---- PDF ---------------------------------------------------------------------------------

async function buildPdf(pages, paper, art, opts, onProgress) {
    const pdf = await PDFLib.PDFDocument.create();
    const W = paper.w * MM_TO_PT;
    const H = paper.h * MM_TO_PT;
    const lineColor = (() => {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(opts.lineColor);
        return PDFLib.rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
    })();
    const hasArt = Object.keys(art).length > 0 || !isWhite(opts.bgColor);

    for (let i = 0; i < pages.length; i++) {
        onProgress && onProgress(`Building page ${i + 1} of ${pages.length}…`);
        const page = pdf.addPage([W, H]);
        const pagePath = (points) => points.map(([x, y], j) => `${j ? 'L' : 'M'}${(x * MM_TO_PT).toFixed(2)} ${(y * MM_TO_PT).toFixed(2)}`).join(' ');

        if (hasArt) {
            // Artwork for the whole page as one image at the chosen resolution.
            const k = opts.dpi / 25.4;
            const c = document.createElement('canvas');
            c.width = Math.round(paper.w * k);
            c.height = Math.round(paper.h * k);
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.scale(k, k);
            pages[i].items.forEach((item) => {
                ctx.save();
                applyPieceTransform(ctx, item);
                drawPieceArt(ctx, item.piece, art, opts);
                ctx.restore();
            });
            const blob = await PnP.canvasToBlob(c, 'image/jpeg', 0.92);
            c.width = 0;
            const img = await pdf.embedJpg(await blob.arrayBuffer());
            page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        }

        pages[i].items.forEach((item) => {
            const map = toPage(item);
            if (opts.printFold) {
                item.piece.folds.forEach(([a, b]) => {
                    const [ax, ay] = map(a), [bx, by] = map(b);
                    page.drawLine({
                        start: { x: ax * MM_TO_PT, y: H - ay * MM_TO_PT },
                        end: { x: bx * MM_TO_PT, y: H - by * MM_TO_PT },
                        thickness: 0.5,
                        color: lineColor,
                        dashArray: [4, 3],
                    });
                });
            }
            if (opts.printCut) {
                item.piece.cuts.forEach((loop) => {
                    page.drawSvgPath(`${pagePath(loop.map(map))} Z`, { x: 0, y: H, borderColor: lineColor, borderWidth: 0.5 });
                });
            }
        });
    }
    return pdf.save();
}

// ---- SVG cut file -------------------------------------------------------------------------

function buildSvg(page, paper) {
    const f = (v) => +v.toFixed(3);
    const cut = [];
    const score = [];
    page.items.forEach((item) => {
        const map = toPage(item);
        item.piece.cuts.forEach((loop) => {
            cut.push(`  <path d="${loop.map(map).map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ')} Z"/>`);
        });
        item.piece.folds.forEach(([a, b]) => {
            const [ax, ay] = map(a), [bx, by] = map(b);
            score.push(`  <line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}"/>`);
        });
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${paper.w}mm" height="${paper.h}mm" viewBox="0 0 ${paper.w} ${paper.h}">
 <g id="cut" fill="none" stroke="#e03131" stroke-width="0.25">
${cut.join('\n')}
 </g>
 <g id="score" fill="none" stroke="#2b6cb0" stroke-width="0.25" stroke-dasharray="2 1">
${score.join('\n')}
 </g>
</svg>
`;
}
