// PnP Tuck Box: settings, artwork slots, live preview, exports and the shared
// PnPTools hooks.

const $ = (id) => document.getElementById(id);

const state = {
    art: {},    // slot -> { file, img, rot }
    pages: [],
};

const STYLE_HINTS = {
    tuck: 'One piece with a tuck-in lid and bottom. The usual card-deck box.',
    twoPiece: 'A base tray and a slightly larger lid that slides over it. The deck lies flat.',
    sleeve: 'An open band that slides over the deck.',
};

function num(id, fallback = 0) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
}

function readConfig() {
    return {
        style: $('boxStyle').value,
        cardW: num('cardW', 63),
        cardH: num('cardH', 88),
        thickness: Math.max(0.5, num('cardCount', 1) * num('cardThickness', 0.32)),
        clearance: num('clearance', 1),
        paper: num('paperThickness', 0.3),
        lidDepth: Math.min(100, Math.max(20, num('lidDepth', 100))),
        sleeveHeight: Math.min(100, Math.max(15, num('sleeveHeight', 60))),
    };
}

function readOptions() {
    return {
        bgColor: $('bgColor').value,
        bleed: Math.max(0, num('bleed', 3)),
        margin: Math.max(0, num('margin', 5)),
        printCut: $('printCut').checked,
        printFold: $('printFold').checked,
        lineColor: $('lineColor').value,
        dpi: 300,
    };
}

function paperSize() {
    return { w: num('paperW', 210), h: num('paperH', 297) };
}

// ---- Artwork slots -----------------------------------------------------------------------

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`${file.name} is not a readable image`));
        img.src = url;
    });
}

async function setArt(slot, file, rot = 0) {
    try {
        state.art[slot] = { file, img: await loadImage(file), rot };
    } catch (err) {
        PnP.toast(err.message, 'error');
    }
    renderSlots();
    schedule();
}

function pickImage(onFile) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
    input.click();
}

function renderSlots() {
    const list = $('slotList');
    list.innerHTML = '';
    BOX_STYLES[$('boxStyle').value].slots.forEach((slot) => {
        const a = state.art[slot];
        const row = document.createElement('div');
        row.className = 'slot';
        const thumb = document.createElement('div');
        thumb.className = 'slot-thumb' + (a ? '' : ' empty');
        if (a) {
            const img = document.createElement('img');
            img.src = a.img.src;
            img.alt = '';
            img.style.transform = `rotate(${a.rot}deg)`;
            thumb.append(img);
        }
        const name = document.createElement('span');
        name.className = 'slot-name';
        name.textContent = SLOT_LABELS[slot];
        const actions = document.createElement('div');
        actions.className = 'slot-actions';
        const button = (text, label, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.title = label;
            b.setAttribute('aria-label', `${label}: ${SLOT_LABELS[slot]}`);
            b.addEventListener('click', onClick);
            actions.append(b);
        };
        button(a ? 'Change' : 'Add', a ? 'Change image' : 'Add image', () => pickImage((file) => setArt(slot, file, a ? a.rot : 0)));
        if (a) {
            button('⟳', 'Rotate 90°', () => { a.rot = (a.rot + 90) % 360; renderSlots(); schedule(); });
            button('✕', 'Remove image', () => { delete state.art[slot]; renderSlots(); schedule(); });
        }
        row.append(thumb, name, actions);
        list.append(row);
    });
}

// ---- Preview -----------------------------------------------------------------------------

let timer = null;
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 60);
}

function setStatus(message, type = 'info') {
    const el = $('status');
    el.hidden = !message;
    el.textContent = message || '';
    el.className = `status ${type}`;
}

function updateStyleUI() {
    const style = $('boxStyle').value;
    $('styleHint').textContent = STYLE_HINTS[style];
    $('lidDepthGroup').hidden = style !== 'twoPiece';
    $('sleeveHeightGroup').hidden = style !== 'sleeve';
}

function render() {
    updateStyleUI();
    const cfg = readConfig();
    const opts = readOptions();
    const paper = paperSize();
    let pieces;
    try {
        pieces = buildBox(cfg.style, cfg);
    } catch (err) {
        console.error(err);
        setStatus(`Could not build the box: ${err.message}`, 'error');
        return;
    }
    state.pages = layoutPages(pieces, paper, opts.margin, opts.bleed);

    const d = boxDims(cfg);
    const fmt = (mm) => PnP.units.format(mm);
    const outer = cfg.style === 'twoPiece'
        ? `Base inside ${fmt(d.W + 2 * d.t)} × ${fmt(d.H + 2 * d.t)} × ${fmt(d.D + d.t)} deep`
        : `Inside ${fmt(d.W)} × ${fmt(d.H)} × ${fmt(d.D)}`;
    $('summary').innerHTML = '';
    [
        ['Deck', `${num('cardCount')} cards, ${fmt(cfg.thickness)} thick`],
        ['Box', outer],
        ['Pieces', pieces.map((p) => `${p.name} ${fmt(p.width)} × ${fmt(p.height)}`).join(' · ')],
        ['Pages', String(state.pages.length)],
    ].forEach(([label, value]) => {
        const item = document.createElement('div');
        item.className = 'summary-item';
        item.innerHTML = '<span class="summary-label"></span><span class="summary-value"></span>';
        item.children[0].textContent = label;
        item.children[1].textContent = value;
        $('summary').append(item);
    });

    const tooBig = state.pages.some((p) => p.items.some((i) => !i.fits));
    setStatus(tooBig ? 'The box is larger than the printable area of this paper. Choose a larger paper (e.g. A3) or reduce the margin.' : '', 'error');

    const grid = $('sheetGrid');
    grid.innerHTML = '';
    const maxWidth = Math.min(520, Math.max(240, grid.clientWidth / Math.min(2, state.pages.length) - 24));
    state.pages.forEach((page, i) => {
        const fig = document.createElement('figure');
        fig.className = 'sheet';
        const canvas = document.createElement('canvas');
        const k = drawPagePreview(canvas, page, { paper, art: state.art, opts, maxWidth, showLabels: $('showLabels').checked });
        attachDrop(canvas, page, k);
        const cap = document.createElement('figcaption');
        cap.textContent = `Page ${i + 1} · ${page.items.map((it) => it.piece.name).join(' + ')}`;
        fig.append(canvas, cap);
        grid.append(fig);
    });
}

// Dropping an image on a panel assigns it to that panel's artwork slot.
function attachDrop(canvas, page, k) {
    canvas.addEventListener('dragover', (e) => {
        e.preventDefault();
        canvas.classList.add('dragover');
    });
    canvas.addEventListener('dragleave', () => canvas.classList.remove('dragover'));
    canvas.addEventListener('drop', (e) => {
        e.preventDefault();
        canvas.classList.remove('dragover');
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
        if (!file) return;
        const rect = canvas.getBoundingClientRect();
        const slot = slotAt(page, (e.clientX - rect.left) / k, (e.clientY - rect.top) / k);
        if (slot) setArt(slot, file, state.art[slot]?.rot || 0);
        else PnP.toast('Drop the image onto a printable panel (front, back, sides, top…).', 'error');
    });
}

// ---- Card thickness preset ---------------------------------------------------------------

function syncThicknessPreset() {
    const v = num('cardThickness');
    const match = [...$('thicknessPreset').options].find((o) => o.value !== 'custom' && Math.abs(parseFloat(o.value) - v) < 0.001);
    $('thicknessPreset').value = match ? match.value : 'custom';
}

$('thicknessPreset').addEventListener('change', () => {
    const v = $('thicknessPreset').value;
    if (v === 'custom') return;
    $('cardThickness').value = v;
    $('cardThickness').dispatchEvent(new Event('input', { bubbles: true }));
});
$('cardThickness').addEventListener('input', syncThicknessPreset);
$('thicknessPreset').dataset.persist = 'false';

// ---- Export --------------------------------------------------------------------------------

$('downloadPdf').addEventListener('click', async () => {
    const btn = $('downloadPdf');
    btn.disabled = true;
    try {
        const bytes = await buildPdf(state.pages, paperSize(), state.art, readOptions(), (m) => setStatus(m, 'processing'));
        PnP.downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${$('boxStyle').value}-box.pdf`);
        setStatus('');
    } catch (err) {
        console.error(err);
        setStatus(`Could not build the PDF: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        render();
    }
});

$('downloadSvg').addEventListener('click', async () => {
    const paper = paperSize();
    const svgs = state.pages.map((page) => buildSvg(page, paper));
    const base = `${$('boxStyle').value}-box-cut`;
    if (svgs.length === 1) {
        PnP.downloadBlob(new Blob([svgs[0]], { type: 'image/svg+xml' }), `${base}.svg`);
    } else {
        const zip = await PnP.zip.create(svgs.map((svg, i) => ({ name: `${base}-page-${i + 1}.svg`, data: svg })));
        PnP.downloadBlob(zip, `${base}.zip`);
    }
});

// ---- Wiring ----------------------------------------------------------------------------------

document.querySelector('.sidebar').addEventListener('input', schedule);
document.querySelector('.sidebar').addEventListener('change', schedule);
$('boxStyle').addEventListener('change', renderSlots);
$('showLabels').addEventListener('change', render);
window.addEventListener('resize', schedule);
PnP.units.onChange(schedule);

PnP.bindPreset($('cardPreset'), $('cardW'), $('cardH'), 'card');
PnP.bindPreset($('paperPreset'), $('paperW'), $('paperH'), 'paper');
PnP.settings.onApply(() => { syncThicknessPreset(); renderSlots(); });

// Images from other tools fill the empty slots of the current style in order.
async function fillSlots(files) {
    const empty = BOX_STYLES[$('boxStyle').value].slots.filter((s) => !state.art[s]);
    const images = files.filter((f) => f.type.startsWith('image/'));
    for (let i = 0; i < Math.min(empty.length, images.length); i++) await setArt(empty[i], images[i]);
    if (images.length > empty.length) PnP.toast(`Used ${empty.length} of ${images.length} images — there were no more empty panels.`, 'info');
}
PnP.importButton($('importSlot'), fillSlots);

let projectFiles = [];
PnP.init({
    tool: 'PnPTuckBox',
    project: {
        getFiles: () => Object.entries(state.art).map(([slot, a]) => ({ name: a.file.name, blob: a.file, role: slot })),
        getState: () => ({ rotations: Object.fromEntries(Object.entries(state.art).map(([slot, a]) => [slot, a.rot])) }),
        setFiles: (files) => { projectFiles = files; },
        setState: async (saved) => {
            state.art = {};
            const rotations = (saved && saved.rotations) || {};
            for (const f of projectFiles) {
                if (f.pnpRole) await setArt(f.pnpRole, f, rotations[f.pnpRole] || 0);
            }
            renderSlots();
            schedule();
        },
    },
    hasUnsavedWork: () => Object.keys(state.art).length > 0,
});

PnP.handoff.receive((items) => fillSlots(PnP.itemsToFiles(items)));

syncThicknessPreset();
renderSlots();
render();
