import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import {
    PATCH_MARKER,
    PatchError,
    getDefaultAppAsarPath,
    getPatchStatus,
    patchAsar,
    resolveAsarTarget,
    restoreAsar,
    runDoctor
} from '../src/patcher.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-persian-rtl-'));

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listUnpackedEntries(asarPath) {
    const raw = asar.getRawHeader(asarPath);
    const out = [];
    function walk(node, prefix) {
        for (const [k, v] of Object.entries(node.files || {})) {
            const p = prefix ? `${prefix}/${k}` : k;
            if ('files' in v) walk(v, p);
            else if (v.unpacked) out.push(p);
        }
    }
    walk(raw.header, '');
    return out.sort();
}

async function createSampleAsar(dir, utilsCode, pkgVersion = '2.31.2') {
    const src = path.join(dir, 'src');
    fs.mkdirSync(path.join(src, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'antigravity', version: pkgVersion }));
    fs.writeFileSync(path.join(src, 'dist', 'utils.js'), utilsCode);
    const asarPath = path.join(dir, 'app.asar');
    await asar.createPackage(src, asarPath);
    return asarPath;
}

test('synthetic ASAR: patch, idempotent --if-needed, update repatch, and exact_backup restore', async () => {
    const root = tmpDir();
    try {
        const v1Dir = path.join(root, 'v1');
        fs.mkdirSync(v1Dir);
        const asarPath = await createSampleAsar(
            v1Dir,
            'module.exports = (win, url) => {\n    void win.loadURL(url);\n    return win;\n};\n'
        );

        assert.equal(getPatchStatus(asarPath).state, 'unpatched');
        assert.equal(getPatchStatus(asarPath).appVersion, '2.31.2');

        const r1 = patchAsar(asarPath, { ifNeeded: true });
        assert.equal(r1.changed, true);
        assert.equal(getPatchStatus(asarPath).state, 'patched');
        assert.equal(getPatchStatus(asarPath).backupState, 'clean');

        const r2 = patchAsar(asarPath, { ifNeeded: true });
        assert.equal(r2.changed, false);
        assert.equal(r2.status, 'already_patched');

        // Simulate Antigravity auto-update overwriting app.asar while v1 backup exists.
        const v2Src = path.join(root, 'v2src');
        fs.mkdirSync(path.join(v2Src, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(v2Src, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.0' }));
        fs.writeFileSync(
            path.join(v2Src, 'dist', 'utils.js'),
            'module.exports = (win, url) => {\n    /* v2 */\n    void win.loadURL(url);\n    return win;\n};\n'
        );
        await asar.createPackage(v2Src, asarPath);
        const v2Hash = sha256File(asarPath);

        assert.equal(getPatchStatus(asarPath).state, 'unpatched');
        const r3 = patchAsar(asarPath, { ifNeeded: true });
        assert.equal(r3.changed, true);
        assert.ok(asar.extractFile(asarPath, 'dist/utils.js').toString('utf8').includes('/* v2 */'));

        const res = restoreAsar(asarPath);
        assert.equal(res.restored, true);
        assert.equal(res.mode, 'exact_backup');
        assert.equal(sha256File(asarPath), v2Hash);
        assert.equal(fs.existsSync(`${asarPath}.bak`), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('recovery fallback: strip_fallback works without .bak and restore is idempotent when already original', async () => {
    const root = tmpDir();
    try {
        const cleanUtils = 'module.exports = (win, url) => {\n    void win.loadURL(url);\n    return win;\n};\n';
        const asarPath = await createSampleAsar(root, cleanUtils);

        patchAsar(asarPath);
        // Simulate missing .bak file.
        fs.rmSync(`${asarPath}.bak`, { force: true });
        assert.equal(getPatchStatus(asarPath).hasBackup, false);

        // Strict backup mode must fail clearly when .bak is absent.
        assert.throws(
            () => restoreAsar(asarPath, { strictBackup: true }),
            err => err instanceof PatchError && err.code === 'NO_BACKUP' && err.fix.length > 0
        );

        // Default self-healing fallback cleanly strips injected payload & font.
        const fallbackRes = restoreAsar(asarPath);
        assert.equal(fallbackRes.restored, true);
        assert.equal(fallbackRes.mode, 'strip_fallback');
        assert.equal(getPatchStatus(asarPath).state, 'unpatched');
        assert.equal(getPatchStatus(asarPath).hasFont, false);
        assert.equal(asar.extractFile(asarPath, 'dist/utils.js').toString('utf8'), cleanUtils);

        // Running restore again returns idempotent already_original.
        const secondRes = restoreAsar(asarPath);
        assert.equal(secondRes.restored, false);
        assert.equal(secondRes.mode, 'already_original');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('error diagnostics: ASAR_NOT_FOUND, ANCHOR_NOT_FOUND, CORRUPT_ASAR, directory --path resolution, and doctor', async () => {
    const root = tmpDir();
    try {
        assert.throws(
            () => patchAsar(path.join(root, 'does-not-exist.asar')),
            err => err instanceof PatchError && err.code === 'ASAR_NOT_FOUND' && err.fix.length > 0
        );

        // Anchor mismatch must abort BEFORE creating .bak or modifying app.asar.
        const noAnchorDir = path.join(root, 'no-anchor');
        fs.mkdirSync(noAnchorDir);
        const noAnchorAsar = await createSampleAsar(noAnchorDir, 'module.exports = () => "changed hook";\n');
        const beforeHash = sha256File(noAnchorAsar);
        assert.throws(
            () => patchAsar(noAnchorAsar),
            err => err instanceof PatchError && err.code === 'ANCHOR_NOT_FOUND' && err.fix.length > 0
        );
        assert.equal(sha256File(noAnchorAsar), beforeHash);
        assert.equal(fs.existsSync(`${noAnchorAsar}.bak`), false);

        // Directory target resolution (<dir>/resources/app.asar).
        const installRoot = path.join(root, 'AntigravityDir');
        const resDir = path.join(installRoot, 'resources');
        fs.mkdirSync(resDir, { recursive: true });
        const dirAsar = await createSampleAsar(resDir, 'module.exports = (win, url) => {\n    void win.loadURL(url);\n    return win;\n};\n');
        assert.equal(resolveAsarTarget(installRoot), dirAsar);

        // Corrupt ASAR detection without throwing inside status/doctor.
        const badAsar = path.join(root, 'corrupt.asar');
        fs.writeFileSync(badAsar, 'not-an-asar-header');
        assert.equal(getPatchStatus(badAsar).state, 'corrupt');
        assert.throws(
            () => patchAsar(badAsar),
            err => err instanceof PatchError && err.code === 'CORRUPT_ASAR'
        );

        // Doctor healthy pass & CLI structured error output.
        const docPass = runDoctor(dirAsar);
        assert.equal(docPass.healthy, true);
        assert.equal(docPass.overall, 'PASS');

        const docFail = runDoctor(path.join(root, 'missing.asar'));
        assert.equal(docFail.healthy, false);
        assert.equal(docFail.overall, 'FAIL');

        let cliOut = '';
        try {
            execFileSync(process.execPath, [fileURLToPath(new URL('../src/patcher.mjs', import.meta.url)), 'bogus', '--json'], { encoding: 'utf8', stdio: 'pipe' });
            assert.fail('Expected invalid command to fail');
        } catch (cliErr) {
            cliOut = cliErr.stderr || cliErr.stdout || '';
        }
        const parsed = JSON.parse(cliOut);
        assert.equal(parsed.code, 'INVALID_COMMAND');
        assert.ok(parsed.fix.length > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('security audit: origin guard, config sanitization, zero network/openExternal, valid client JS', async () => {
    const root = tmpDir();
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    try {
        const asarPath = await createSampleAsar(
            root,
            'module.exports = (win, url) => {\n    void win.loadURL(url);\n    return win;\n};\n'
        );
        patchAsar(asarPath);

        const utilsCode = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
        assert.ok(!utilsCode.includes('api.github.com'));
        assert.ok(!utilsCode.includes('openExternal'));
        assert.ok(!/\bfetch\s*\(/.test(utilsCode));

        process.env.HOME = root;
        process.env.USERPROFILE = root;
        const cfgPath = path.join(root, '.antigravity-rtl.json');
        fs.writeFileSync(cfgPath, JSON.stringify({
            faFont: '"><img src=x onerror=alert(1)>',
            enFont: 'Inter',
            lh: '99',
            fs: '200',
            evilKey: 'drop'
        }));

        const handlers = {};
        let currentUrl = 'https://evil.example/page';
        let injectedScript = null;
        const win = {
            loadURL() {},
            webContents: {
                on: (ev, fn) => { handlers[ev] = fn; },
                getURL: () => currentUrl,
                executeJavaScript: (code) => { injectedScript = code; return Promise.resolve(); }
            }
        };

        const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
        const mod = { exports: {} };
        new Function('module', 'require', '__dirname', utilsCode)(mod, createRequire(import.meta.url), srcDir);
        mod.exports(win, 'http://127.0.0.1:4000/');

        // 1. Untrusted origin must NOT trigger injection or console config write.
        handlers['dom-ready']();
        assert.equal(injectedScript, null);
        handlers['console-message']({}, 0, 'AG_RTL_SAVE|{"enFont":"HackFont"}');
        handlers['console-message']({ message: 'AG_RTL_SAVE|{"enFont":"HackFont"}' });
        assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).enFont, 'Inter');

        // 2. Local origin triggers injection with sanitized config.
        currentUrl = 'http://127.0.0.1:4000/';
        handlers['dom-ready']();
        assert.ok(injectedScript);
        assert.doesNotThrow(() => new vm.Script(injectedScript), 'Client script must parse cleanly');
        assert.ok(injectedScript.includes('"enFont":"Inter"'));
        assert.ok(injectedScript.includes('"lh":"1.6"'));
        assert.ok(injectedScript.includes('"fs":"16"'));
        assert.ok(injectedScript.includes('[data-ag-rtl-managed="1"][dir="rtl"]'));
        assert.ok(injectedScript.includes('unicode-bidi: isolate !important;'));
        assert.ok(!injectedScript.includes('onerror=alert'));
        assert.ok(!injectedScript.includes('evilKey'));

        // 3. Local origin console-message sanitizes incoming config & drops unknown keys (legacy & object forms).
        handlers['console-message']({}, 0, 'AG_RTL_SAVE|{"fs":"18","faFont":"Vazirmatn","bad":"x","lh":"9.9"}');
        let saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(saved.fs, '18');
        assert.equal(saved.faFont, 'Vazirmatn');
        assert.equal(saved.lh, '1.6');
        assert.equal(saved.bad, undefined);

        handlers['console-message']({ message: 'AG_RTL_SAVE|{"fs":"20","forceRTL":true}' });
        saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(saved.fs, '20');
        assert.equal(saved.forceRTL, true);

        // 4. Antigravity v2.32+ BaseWindow + WebContentsView (hubContents without win.webContents).
        const hubRoot = path.join(root, 'basewindow');
        fs.mkdirSync(hubRoot);
        const hubAsar = await createSampleAsar(
            hubRoot,
            'module.exports = (win, url, hubContents) => {\n    void win.loadURL(url);\n    return win;\n};\n'
        );
        patchAsar(hubAsar);
        const hubUtilsCode = asar.extractFile(hubAsar, 'dist/utils.js').toString('utf8');
        const hubHandlers = {};
        let hubUrl = 'https://evil.example/hub';
        let hubInjected = null;
        const hubWin = { loadURL() {} };
        const hubContents = {
            on: (ev, fn) => { hubHandlers[ev] = fn; },
            getURL: () => hubUrl,
            executeJavaScript: (code) => { hubInjected = code; return Promise.resolve(); }
        };
        const hubMod = { exports: {} };
        new Function('module', 'require', '__dirname', hubUtilsCode)(hubMod, createRequire(import.meta.url), srcDir);
        hubMod.exports(hubWin, 'http://127.0.0.1:4001/', hubContents);
        hubHandlers['dom-ready']();
        assert.equal(hubInjected, null);
        hubUrl = 'http://127.0.0.1:4001/';
        hubHandlers['dom-ready']();
        assert.ok(hubInjected);
        assert.doesNotThrow(() => new vm.Script(hubInjected));
    } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevUserProfile;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bidi-engine clean-room controller: inline-code-start Persian -> RTL, URL skip, non-destructive restoreAll', () => {
    const engineCode = fs.readFileSync(new URL('../src/bidi-engine.js', import.meta.url), 'utf8');

    const makeText = (value) => ({ nodeType: 3, nodeValue: value });
    const makeEl = (tag, childrenOrText, { closestMatch = null, initialDir = null, matchesSel = '' } = {}) => {
        const attrs = new Map();
        if (initialDir !== null) attrs.set('dir', initialDir);
        const childNodes = Array.isArray(childrenOrText)
            ? childrenOrText
            : [makeText(childrenOrText)];
        const collectText = (nodes) => nodes.map(n => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join('');
        return {
            nodeType: 1,
            tagName: tag,
            childNodes,
            get textContent() { return collectText(childNodes); },
            set textContent(v) { childNodes.splice(0, childNodes.length, makeText(v)); },
            value: typeof childrenOrText === 'string' ? childrenOrText : collectText(childNodes),
            getAttribute: (k) => attrs.get(k) ?? null,
            setAttribute: (k, v) => attrs.set(k, v),
            hasAttribute: (k) => attrs.has(k),
            removeAttribute: (k) => attrs.delete(k),
            matches: (sel) => {
                if (sel.includes(tag.toLowerCase())) return true;
                return matchesSel ? sel.includes(matchesSel) : false;
            },
            closest: (sel) => (closestMatch && sel.includes(closestMatch) ? {} : null)
        };
    };

    const pFa = makeEl('P', 'این یک متن فارسی با API انگلیسی است.');
    const pInlineCodeStartFa = makeEl('P', [
        makeEl('CODE', 'src/patcher.mjs'),
        makeText(' رو بررسی کردم و خطای '),
        makeEl('CODE', 'EBUSY'),
        makeText(' برطرف شد.')
    ]);
    const pUrlStartFa = makeEl('P', [
        makeEl('A', 'https://github.com/IRDcode'),
        makeText(' این مخزن متن‌باز فارسی است.')
    ]);
    const pRelPathStartFa = makeEl('P', 'src/patcher.mjs را بررسی کردم و خطای EBUSY برطرف شد.');
    const pMonoSpanFa = makeEl('P', [
        makeEl('SPAN', 'src/patcher.mjs', { matchesSel: '.font-mono' }),
        makeText(' باز شد.')
    ]);
    const pEn = makeEl('P', 'This is an English paragraph with فارسی inside.');
    const pNativeLtr = makeEl('P', 'تست بازگشت غیرمخرب', { initialDir: 'ltr' });
    const codeEl = makeEl('CODE', 'const فارسی = 1;');
    const monacoEl = makeEl('P', 'سلام', { closestMatch: '.monaco-editor' });
    const inputFa = makeEl('P', 'سلام دنیا');
    const inputEmpty = makeEl('P', '   ', { initialDir: 'rtl' });

    const allBlocks = [pFa, pInlineCodeStartFa, pUrlStartFa, pRelPathStartFa, pMonoSpanFa, pEn, pNativeLtr, codeEl, monacoEl];
    const allInputs = [inputFa, inputEmpty];

    const sandbox = {
        window: {},
        document: {
            body: { addEventListener() {}, removeEventListener() {} },
            addEventListener() {},
            querySelectorAll: (sel) => {
                if (sel.includes('data-ag-rtl-managed')) {
                    return [...allBlocks, ...allInputs].filter(el => el.hasAttribute('data-ag-rtl-managed'));
                }
                if (sel.includes('contenteditable')) return allInputs;
                return allBlocks;
            }
        },
        MutationObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: (fn) => setTimeout(fn, 0)
    };
    vm.runInNewContext(engineCode, sandbox);
    const engine = sandbox.window.__agPersianBidi;

    engine.updateAll(false);
    assert.equal(pFa.getAttribute('dir'), 'rtl');
    assert.equal(pInlineCodeStartFa.getAttribute('dir'), 'rtl', 'Inline code at start must NOT force LTR');
    assert.equal(pUrlStartFa.getAttribute('dir'), 'rtl', 'Leading URL must NOT force LTR');
    assert.equal(pRelPathStartFa.getAttribute('dir'), 'rtl', 'Leading relative path must NOT force LTR');
    assert.equal(pMonoSpanFa.getAttribute('dir'), 'rtl', '.font-mono token at start must NOT force LTR');
    assert.equal(pEn.getAttribute('dir'), 'ltr');
    assert.equal(pNativeLtr.getAttribute('dir'), 'rtl');
    assert.equal(codeEl.getAttribute('dir'), null);
    assert.equal(monacoEl.getAttribute('dir'), null);
    assert.equal(inputFa.getAttribute('dir'), 'rtl');
    assert.equal(inputEmpty.getAttribute('dir'), null);

    // Non-destructive toggle-off must restore pre-existing native dir attributes and strip managed attrs.
    engine.restoreAll();
    assert.equal(pFa.getAttribute('dir'), null);
    assert.equal(pNativeLtr.getAttribute('dir'), 'ltr');
    assert.equal(pNativeLtr.hasAttribute('data-ag-rtl-managed'), false);
    assert.equal(inputEmpty.getAttribute('dir'), 'rtl');

    // Force RTL overrides prose to rtl while leaving code untouched.
    engine.updateAll(true);
    assert.equal(pEn.getAttribute('dir'), 'rtl');
    assert.equal(codeEl.getAttribute('dir'), null);
});

test('auto-upgrade: legacy v1.0 HARDENED and v1.1 clean-room blocks upgrade cleanly to v1.2 via --if-needed', async () => {
    const root = tmpDir();
    try {
        const legacyPayload = [
            'module.exports = (win, url) => {',
            '    /* ANTIGRAVITY RTL HARDENED v1.0 */',
            '    /* simulated older version */',
            '    void win.loadURL(url);',
            '    /* END ANTIGRAVITY RTL HARDENED */',
            '    return win;',
            '};'
        ].join('\n');
        const legacyDir = path.join(root, 'v10');
        fs.mkdirSync(legacyDir);
        const asarPath = await createSampleAsar(legacyDir, legacyPayload);
        assert.equal(getPatchStatus(asarPath).state, 'legacy_or_stale');

        const upgrade = patchAsar(asarPath, { ifNeeded: true });
        assert.equal(upgrade.changed, true);
        assert.equal(getPatchStatus(asarPath).state, 'patched');

        const utils = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
        assert.ok(utils.includes(PATCH_MARKER));
        assert.ok(!utils.includes('ANTIGRAVITY RTL HARDENED'));

        const res = restoreAsar(asarPath);
        assert.equal(res.restored, true);
        assert.equal(getPatchStatus(asarPath).state, 'unpatched');

        const v11Payload = [
            'module.exports = (win, url) => {',
            '    /* ANTIGRAVITY PERSIAN RTL v1.1 */',
            '    /* simulated v1.1 clean-room runtime */',
            '    void win.loadURL(url);',
            '    /* END ANTIGRAVITY PERSIAN RTL */',
            '    return win;',
            '};'
        ].join('\n');
        const v11Dir = path.join(root, 'v11');
        fs.mkdirSync(v11Dir);
        const v11Asar = await createSampleAsar(v11Dir, v11Payload);
        assert.equal(getPatchStatus(v11Asar).state, 'legacy_or_stale');
        const up12 = patchAsar(v11Asar, { ifNeeded: true });
        assert.equal(up12.changed, true);
        assert.equal(getPatchStatus(v11Asar).state, 'patched');
        const v12Utils = asar.extractFile(v11Asar, 'dist/utils.js').toString('utf8');
        assert.ok(v12Utils.includes(PATCH_MARKER));
        assert.ok(!v12Utils.includes('ANTIGRAVITY PERSIAN RTL v1.1'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('installed Antigravity app.asar copy (when present): preserves unpacked entries and restores cleanly', () => {
    const liveAsar = process.env.ANTIGRAVITY_ASAR_PATH || getDefaultAppAsarPath();
    if (!liveAsar || !fs.existsSync(liveAsar)) return;

    const root = tmpDir();
    try {
        const copyAsar = path.join(root, 'app.asar');
        fs.copyFileSync(liveAsar, copyAsar);
        const st = getPatchStatus(copyAsar);
        if (st.state !== 'unpatched') {
            // Even when live app.asar is already patched, verify strip_fallback -> clean -> patch cycle preserves unpacked entries.
            const origUnpacked = listUnpackedEntries(copyAsar);
            const res0 = restoreAsar(copyAsar);
            assert.equal(res0.restored, true);
            assert.equal(getPatchStatus(copyAsar).state, 'unpatched');
            const unpatchedHash = sha256File(copyAsar);
            const p = patchAsar(copyAsar, { ifNeeded: true });
            assert.equal(p.changed, true);
            assert.deepEqual(listUnpackedEntries(copyAsar), origUnpacked);
            restoreAsar(copyAsar);
            assert.equal(sha256File(copyAsar), unpatchedHash);
            return;
        }

        const origHash = sha256File(copyAsar);
        const origUnpacked = listUnpackedEntries(copyAsar);
        assert.ok(origUnpacked.length > 0, 'Expected unpacked entries in Antigravity app.asar');

        const patchRes = patchAsar(copyAsar, { ifNeeded: true });
        assert.equal(patchRes.changed, true);

        const patchedUtils = asar.extractFile(copyAsar, 'dist/utils.js').toString('utf8');
        assert.ok(patchedUtils.includes(PATCH_MARKER));
        assert.doesNotThrow(() => new vm.Script(patchedUtils));

        assert.deepEqual(listUnpackedEntries(copyAsar), origUnpacked);
        assert.equal(patchAsar(copyAsar, { ifNeeded: true }).changed, false);

        restoreAsar(copyAsar);
        assert.equal(sha256File(copyAsar), origHash);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sibling mod coexistence: preserves Context Monitor block on patch & restore', async () => {
    const root = tmpDir();
    try {
        const siblingHeader = '/* ANTIGRAVITY CONTEXT MONITOR v1.0 */\n(() => {})(win);\n/* END ANTIGRAVITY CONTEXT MONITOR */\n';
        const withSibling = `module.exports = (win, url) => {\n${siblingHeader}void win.loadURL(url);\n    return win;\n};\n`;
        const asarPath = await createSampleAsar(root, withSibling);

        const p = patchAsar(asarPath, { ifNeeded: true });
        assert.equal(p.changed, true);
        const st = getPatchStatus(asarPath);
        assert.equal(st.state, 'patched');
        assert.equal(st.contextMonitorPresent, true);
        assert.equal(st.backupState, 'clean');

        const patchedUtils = asar.extractFile(asarPath, 'dist/utils.js').toString('utf8');
        assert.ok(patchedUtils.includes(PATCH_MARKER));
        assert.ok(patchedUtils.includes('/* ANTIGRAVITY CONTEXT MONITOR v1.0 */'));
        assert.doesNotThrow(() => new vm.Script(patchedUtils));

        const res = restoreAsar(asarPath);
        assert.equal(res.restored, true);
        assert.equal(res.mode, 'strip_preserve_sibling');
        assert.equal(getPatchStatus(asarPath).state, 'unpatched');
        assert.equal(getPatchStatus(asarPath).contextMonitorPresent, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
