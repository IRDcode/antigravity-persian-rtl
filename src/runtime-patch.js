/* ANTIGRAVITY PERSIAN RTL v1.2 */
((win) => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const LOCAL_ORIGIN_RE = /^https?:\/\/127\.0\.0\.1:\d+/i;
    const SAFE_FONT_TOKEN_RE = /^[\p{L}\p{N} ._-]{0,64}$/u;
    const SAVE_PREFIX = 'AG_RTL_SAVE|';

    const BASE_CONFIG = {
        faFont: '',
        enFont: '',
        codeFont: '',
        lh: '1.6',
        fs: '16',
        isRTL: true,
        forceRTL: false
    };

    function sanitizeSettings(raw) {
        const clean = {};
        if (!raw || typeof raw !== 'object') return clean;
        for (const key of ['faFont', 'enFont', 'codeFont']) {
            if (typeof raw[key] === 'string' && SAFE_FONT_TOKEN_RE.test(raw[key])) {
                clean[key] = raw[key];
            }
        }
        if (raw.lh !== undefined) {
            const n = Number(raw.lh);
            if (Number.isFinite(n) && n >= 1.0 && n <= 3.0) {
                clean.lh = String(Number(n.toFixed(1)));
            }
        }
        if (raw.fs !== undefined) {
            const n = Number(raw.fs);
            if (Number.isInteger(n) && n >= 10 && n <= 28) {
                clean.fs = String(n);
            }
        }
        if (typeof raw.isRTL === 'boolean') clean.isRTL = raw.isRTL;
        if (typeof raw.forceRTL === 'boolean') clean.forceRTL = raw.forceRTL;
        return clean;
    }

    function settingsFilePath() {
        return path.join(os.homedir(), '.antigravity-rtl.json');
    }

    function readSettings() {
        let merged = { ...BASE_CONFIG };
        try {
            const file = settingsFilePath();
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                merged = { ...merged, ...sanitizeSettings(parsed) };
            }
        } catch (_) {}
        return merged;
    }

    function isLocalAppUrl(rawUrl) {
        return typeof rawUrl === 'string' && LOCAL_ORIGIN_RE.test(rawUrl);
    }

    const targetContents = (typeof hubContents !== 'undefined' && hubContents)
        ? hubContents
        : (win && win.webContents);

    if (targetContents && typeof targetContents.on === 'function') {
        targetContents.on('console-message', (eventOrDetails, ...args) => {
            if (!isLocalAppUrl(targetContents.getURL())) return;
            const msg = (args.length === 0 && eventOrDetails && typeof eventOrDetails === 'object')
                ? eventOrDetails.message
                : args[1];
            if (typeof msg !== 'string' || !msg.startsWith(SAVE_PREFIX)) return;

            try {
                const patch = sanitizeSettings(JSON.parse(msg.slice(SAVE_PREFIX.length)));
                const file = settingsFilePath();
                let current = {};
                if (fs.existsSync(file)) {
                    try {
                        current = sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
                    } catch (_) {}
                }
                const next = { ...BASE_CONFIG, ...current, ...patch };
                fs.writeFileSync(file, JSON.stringify(next, null, 2));
            } catch (_) {}
        });

        targetContents.on('dom-ready', () => {
            if (!isLocalAppUrl(targetContents.getURL())) return;
            try {
                const fontFile = path.join(__dirname, 'Vazirmatn-Variable.woff2');
                const fontB64 = fs.readFileSync(fontFile).toString('base64');
                const initialCfg = readSettings();

                targetContents.executeJavaScript(__BIDI_ENGINE__ + `(() => {
                if (window.__agPersianRtlMounted) return;
                window.__agPersianRtlMounted = true;

                const FONT_DATA = '${fontB64}';
                const START_CFG = ${JSON.stringify(initialCfg)};

                function hasAppShell() {
                    try {
                        const root = document.getElementById('root');
                        if (!root || root.children.length === 0 || !document.body) return false;
                        return Boolean(
                            document.querySelector('[role="navigation"]') ||
                            document.querySelector('[role="main"]') ||
                            document.querySelector('[contenteditable="true"]')
                        );
                    } catch (_) {
                        return false;
                    }
                }

                function sanitizeFont(v) {
                    return (typeof v === 'string' && /^[\\p{L}\\p{N} ._-]{0,64}$/u.test(v)) ? v : '';
                }

                function mountUi() {
                    const state = {
                        enabled: START_CFG.isRTL !== false,
                        forceRtl: Boolean(START_CFG.forceRTL),
                        faFont: START_CFG.faFont || '',
                        enFont: START_CFG.enFont || '',
                        codeFont: START_CFG.codeFont || '',
                        lh: START_CFG.lh || '1.6',
                        fs: START_CFG.fs || '16'
                    };

                    if (!document.getElementById('ag-rtl-ui-css')) {
                        const uiCss = document.createElement('style');
                        uiCss.id = 'ag-rtl-ui-css';
                        uiCss.textContent = \`
                            #ag-rtl-toolbar-wrap {
                                position: relative;
                                display: inline-flex;
                                align-items: center;
                                -webkit-app-region: no-drag;
                            }
                            #ag-rtl-toolbar-btn {
                                display: inline-flex;
                                align-items: center;
                                gap: 6px;
                                height: 28px;
                                padding: 0 10px;
                                border-radius: 6px;
                                border: 1px solid var(--border, rgba(255,255,255,0.14));
                                background: transparent;
                                color: var(--secondary-foreground, var(--foreground, #e4e4e7));
                                font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
                                font-size: 12.5px;
                                font-weight: 500;
                                line-height: 1;
                                cursor: pointer;
                                user-select: none;
                                -webkit-app-region: no-drag;
                                transition: background-color 140ms ease, border-color 140ms ease;
                            }
                            #ag-rtl-toolbar-btn:hover {
                                background: var(--secondary, rgba(255,255,255,0.08));
                                color: var(--foreground, #ffffff);
                            }
                            .ag-rtl-dot {
                                width: 6px;
                                height: 6px;
                                border-radius: 50%;
                                background: #10b981;
                                box-shadow: 0 0 6px rgba(16,185,129,0.55);
                            }
                            .ag-rtl-dot.off { display: none; }
                            #ag-rtl-drawer {
                                position: fixed;
                                z-index: 999999;
                                width: 272px;
                                padding: 12px;
                                border-radius: 10px;
                                background: var(--popover, var(--card, #141418));
                                color: var(--popover-foreground, var(--foreground, #f4f4f5));
                                border: 1px solid var(--border, rgba(255,255,255,0.14));
                                box-shadow: 0 12px 32px rgba(0,0,0,0.42);
                                font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
                                font-size: 12px;
                                direction: ltr;
                                opacity: 0;
                                transform: translateY(-4px) scale(0.97);
                                pointer-events: none;
                                transition: opacity 140ms ease, transform 140ms cubic-bezier(0.16, 1, 0.3, 1);
                            }
                            #ag-rtl-drawer.open {
                                opacity: 1;
                                transform: translateY(0) scale(1);
                                pointer-events: auto;
                            }
                            .ag-rtl-head {
                                display: flex;
                                align-items: center;
                                justify-content: space-between;
                                padding-bottom: 8px;
                                border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
                                margin-bottom: 8px;
                            }
                            .ag-rtl-title {
                                font-size: 11px;
                                font-weight: 700;
                                letter-spacing: 0.08em;
                                text-transform: uppercase;
                                opacity: 0.78;
                            }
                            .ag-rtl-kbd {
                                font-family: ui-monospace, Menlo, Consolas, monospace;
                                font-size: 10px;
                                font-weight: 600;
                                padding: 2px 6px;
                                border-radius: 4px;
                                background: var(--muted, rgba(255,255,255,0.08));
                                border: 1px solid var(--border, rgba(255,255,255,0.14));
                            }
                            .ag-rtl-row {
                                display: flex;
                                align-items: center;
                                justify-content: space-between;
                                gap: 8px;
                                min-height: 28px;
                                margin-bottom: 6px;
                            }
                            .ag-rtl-row.muted { opacity: 0.42; pointer-events: none; }
                            .ag-rtl-label { font-weight: 500; opacity: 0.9; white-space: nowrap; }
                            .ag-rtl-hint { font-size: 10.5px; opacity: 0.65; margin: -2px 0 8px; line-height: 1.35; }
                            .ag-rtl-switch {
                                position: relative;
                                width: 40px;
                                height: 22px;
                                padding: 0;
                                border: none;
                                border-radius: 999px;
                                background: rgba(161,161,170,0.35);
                                cursor: pointer;
                                transition: background-color 160ms ease;
                                flex-shrink: 0;
                            }
                            .ag-rtl-switch[aria-checked="true"] {
                                background: var(--color-primary, var(--primary, var(--vscode-button-background, #2563eb)));
                            }
                            .ag-rtl-thumb {
                                position: absolute;
                                top: 3px;
                                left: 3px;
                                width: 16px;
                                height: 16px;
                                border-radius: 50%;
                                background: #ffffff;
                                box-shadow: 0 1px 2px rgba(0,0,0,0.35);
                                transition: transform 160ms ease;
                            }
                            .ag-rtl-switch[aria-checked="true"] .ag-rtl-thumb {
                                transform: translateX(18px);
                            }
                            .ag-rtl-sep {
                                height: 1px;
                                background: var(--border, rgba(255,255,255,0.1));
                                margin: 8px 0;
                            }
                            .ag-rtl-input {
                                width: 122px;
                                height: 24px;
                                padding: 2px 8px;
                                border-radius: 5px;
                                font-size: 11.5px;
                                background: var(--muted, #27272a);
                                color: var(--foreground, #f4f4f5);
                                border: 1px solid var(--border, rgba(255,255,255,0.14));
                                outline: none;
                            }
                            .ag-rtl-input:focus {
                                border-color: var(--color-primary, var(--ring, #3b82f6));
                            }
                            .ag-rtl-slider-box {
                                display: flex;
                                align-items: center;
                                gap: 6px;
                            }
                            .ag-rtl-range {
                                width: 84px;
                                accent-color: var(--color-primary, var(--primary, #3b82f6));
                                cursor: pointer;
                            }
                            .ag-rtl-val {
                                min-width: 34px;
                                text-align: right;
                                font-family: ui-monospace, Menlo, Consolas, monospace;
                                font-size: 11px;
                                opacity: 0.78;
                            }
                            .ag-rtl-reset {
                                border: none;
                                background: transparent;
                                color: inherit;
                                opacity: 0.55;
                                cursor: pointer;
                                font-size: 11px;
                                padding: 2px 4px;
                                border-radius: 4px;
                            }
                            .ag-rtl-reset:hover { opacity: 1; background: rgba(255,255,255,0.08); }
                        \`;
                        document.head.appendChild(uiCss);
                    }

                    const contentStyle = document.createElement('style');
                    contentStyle.id = 'ag-rtl-content-css';

                    function renderContentCss() {
                        const fa = sanitizeFont(state.faFont);
                        const en = sanitizeFont(state.enFont);
                        const code = sanitizeFont(state.codeFont);
                        const lhVal = Number(state.lh);
                        const lh = (Number.isFinite(lhVal) && lhVal >= 1.0 && lhVal <= 3.0) ? String(Number(lhVal.toFixed(1))) : '1.6';
                        const fsVal = Number(state.fs);
                        const fs = (Number.isInteger(fsVal) && fsVal >= 10 && fsVal <= 28) ? String(fsVal) : '16';

                        let userFaRule = '';
                        let faFamily = "'AgPersianVazir'";
                        if (fa) {
                            const stem = fa.replace(/[-\\s]?Regular$/i, '');
                            faFamily = "'AgUserPersianFont', 'AgPersianVazir'";
                            userFaRule = \`
                                @font-face {
                                    font-family: 'AgUserPersianFont';
                                    src: local('\${fa}'), local('\${stem}');
                                    font-weight: 400;
                                    unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF;
                                }
                                @font-face {
                                    font-family: 'AgUserPersianFont';
                                    src: local('\${stem} Bold'), local('\${stem}-Bold'), local('\${stem}Bold');
                                    font-weight: 700;
                                    unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF;
                                }
                            \`;
                        }

                        const enFamily = en ? \`'\${en}', ui-sans-serif, system-ui, sans-serif\` : 'ui-sans-serif, system-ui, sans-serif';
                        const codeFamily = code
                            ? \`'\${code}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace\`
                            : 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

                        const forceBlock = (state.enabled && state.forceRtl) ? \`
                            .prose > *:not(pre):not(code):not(kbd):not(samp),
                            [data-testid="chat-message"] > *:not(pre):not(code):not(kbd):not(samp),
                            .markdown-body > *:not(pre):not(code):not(kbd):not(samp),
                            .leading-relaxed > *:not(pre):not(code):not(kbd):not(samp),
                            [data-testid="user-input-step"],
                            [data-testid="user-input-step"] > *:not(pre):not(code):not(kbd):not(samp),
                            div:has(> [role="radiogroup"]),
                            label[for^="ask-opt-"] {
                                direction: rtl !important;
                                text-align: right !important;
                                unicode-bidi: isolate !important;
                            }
                        \` : '';

                        contentStyle.textContent = \`
                            \${userFaRule}
                            @font-face {
                                font-family: 'AgPersianVazir';
                                src: url('data:font/woff2;base64,\${FONT_DATA}') format('woff2');
                                font-weight: 100 900;
                                unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF;
                            }
                            [data-ag-rtl-managed="1"]:not(pre):not(code):not(kbd):not(samp),
                            .prose, .prose *:not(pre):not(code):not(kbd):not(samp),
                            [data-testid="chat-message"], [data-testid="chat-message"] *:not(pre):not(code):not(kbd):not(samp),
                            .markdown-body, .markdown-body *:not(pre):not(code):not(kbd):not(samp),
                            .leading-relaxed, .leading-relaxed *:not(pre):not(code):not(kbd):not(samp),
                            [contenteditable="true"], [contenteditable="true"] *:not(pre):not(code):not(kbd):not(samp),
                            [data-lexical-text="true"],
                            label[for^="ask-opt-"], textarea[data-testid="ask-question-writein"] {
                                font-family: \${faFamily}, \${enFamily}, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji" !important;
                            }
                            .prose, [data-testid="chat-message"], .markdown-body, .leading-relaxed,
                            [contenteditable="true"], [contenteditable="true"] p {
                                font-size: \${fs}px !important;
                            }
                            .prose p, .prose li, .markdown-body p,
                            [data-testid="chat-message"] p, .leading-relaxed,
                            [data-testid="user-input-step"], [data-testid="user-input-step"] div,
                            [data-lexical-text="true"], [contenteditable="true"], [contenteditable="true"] p,
                            label[for^="ask-opt-"], textarea[data-testid="ask-question-writein"] {
                                line-height: \${lh} !important;
                                unicode-bidi: plaintext;
                                text-align: start;
                            }
                            [data-ag-rtl-managed="1"][dir="rtl"],
                            [data-ag-rtl-managed="1"][dir="ltr"] {
                                unicode-bidi: isolate !important;
                                text-align: start !important;
                            }
                            \${forceBlock}
                            [dir="rtl"] > ul, [dir="rtl"] > ol,
                            ul[dir="rtl"], ol[dir="rtl"],
                            [data-ag-rtl-managed="1"][dir="rtl"] ul,
                            [data-ag-rtl-managed="1"][dir="rtl"] ol {
                                padding-inline-start: 1.25rem !important;
                                padding-inline-end: 0 !important;
                            }
                            [dir="rtl"] blockquote {
                                border-left: none !important;
                                border-inline-start: 3px solid var(--border, rgba(255,255,255,0.2)) !important;
                                padding-left: 0 !important;
                                padding-inline-start: 12px !important;
                            }
                            pre, code, kbd, samp, pre *, code *,
                            .monaco-editor, .monaco-editor *,
                            .xterm, .xterm *,
                            .terminal, .terminal *,
                            .cursor-edit.text-secondary-foreground,
                            .cursor-edit.text-secondary-foreground * {
                                unicode-bidi: isolate !important;
                                direction: ltr !important;
                                text-align: left !important;
                                font-family: \${codeFamily} !important;
                            }
                            [data-ag-rtl-managed="1"][dir="rtl"] a[href] {
                                unicode-bidi: isolate;
                            }
                            [role="navigation"][aria-label="Sidebar"] *, .truncate {
                                unicode-bidi: plaintext !important;
                                text-align: start !important;
                            }
                        \`;

                        if (state.enabled) {
                            if (!contentStyle.parentNode) document.head.appendChild(contentStyle);
                        } else if (contentStyle.parentNode) {
                            contentStyle.parentNode.removeChild(contentStyle);
                        }
                    }

                    const isMac = /Mac/i.test(navigator.userAgent || navigator.platform);
                    const shortcutHint = isMac ? '⌥R' : 'Alt+R';

                    const wrap = document.createElement('div');
                    wrap.id = 'ag-rtl-toolbar-wrap';
                    wrap.setAttribute('data-ag-rtl-ui', '1');
                    wrap.innerHTML = \`
                        <button id="ag-rtl-toolbar-btn" type="button" title="Antigravity Persian RTL (\${shortcutHint})" aria-expanded="false">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" stroke="currentColor" stroke-width="1.3"/>
                                <path d="M5 6.2H11.5M7 9.8H11.5M4.5 9.8L5.8 8.5M4.5 9.8L5.8 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span>RTL</span>
                            <span id="ag-rtl-dot" class="ag-rtl-dot \${state.enabled ? '' : 'off'}"></span>
                        </button>
                    \`;

                    const drawer = document.createElement('div');
                    drawer.id = 'ag-rtl-drawer';
                    drawer.setAttribute('data-ag-rtl-ui', '1');
                    drawer.innerHTML = \`
                        <div class="ag-rtl-head">
                            <span class="ag-rtl-title">Persian BiDi · RTL</span>
                            <span class="ag-rtl-kbd">\${shortcutHint}</span>
                        </div>
                        <div class="ag-rtl-row">
                            <span class="ag-rtl-label" id="ag-rtl-status-txt">\${state.enabled ? 'Enabled' : 'Disabled'}</span>
                            <button id="ag-rtl-enable-sw" class="ag-rtl-switch" type="button" role="switch" aria-checked="\${state.enabled}">
                                <span class="ag-rtl-thumb"></span>
                            </button>
                        </div>
                        <div class="ag-rtl-row \${state.enabled ? '' : 'muted'}" id="ag-rtl-force-row">
                            <span class="ag-rtl-label">Force RTL</span>
                            <button id="ag-rtl-force-sw" class="ag-rtl-switch" type="button" role="switch" aria-checked="\${state.forceRtl}">
                                <span class="ag-rtl-thumb"></span>
                            </button>
                        </div>
                        <div class="ag-rtl-hint">Forces chat prose &amp; composer right-to-left while locking code blocks LTR.</div>
                        <div class="ag-rtl-sep"></div>
                        <div id="ag-rtl-controls" class="\${state.enabled ? '' : 'muted'}">
                            <div class="ag-rtl-row">
                                <span class="ag-rtl-label">FA/AR Font</span>
                                <input id="ag-rtl-fa-in" class="ag-rtl-input" type="text" placeholder="Vazirmatn (Built-in)">
                            </div>
                            <div class="ag-rtl-row">
                                <span class="ag-rtl-label">EN Font</span>
                                <input id="ag-rtl-en-in" class="ag-rtl-input" type="text" placeholder="System UI">
                            </div>
                            <div class="ag-rtl-row">
                                <span class="ag-rtl-label">Code Font</span>
                                <input id="ag-rtl-code-in" class="ag-rtl-input" type="text" placeholder="Monospace">
                            </div>
                            <div class="ag-rtl-row">
                                <span class="ag-rtl-label">Line Height</span>
                                <div class="ag-rtl-slider-box">
                                    <input id="ag-rtl-lh-in" class="ag-rtl-range" type="range" min="1.2" max="2.5" step="0.1">
                                    <span id="ag-rtl-lh-val" class="ag-rtl-val">1.6×</span>
                                    <button id="ag-rtl-lh-rst" class="ag-rtl-reset" type="button" title="Reset Line Height">↺</button>
                                </div>
                            </div>
                            <div class="ag-rtl-row" style="margin-bottom:0">
                                <span class="ag-rtl-label">Font Size</span>
                                <div class="ag-rtl-slider-box">
                                    <input id="ag-rtl-fs-in" class="ag-rtl-range" type="range" min="11" max="22" step="1">
                                    <span id="ag-rtl-fs-val" class="ag-rtl-val">16px</span>
                                    <button id="ag-rtl-fs-rst" class="ag-rtl-reset" type="button" title="Reset Font Size">↺</button>
                                </div>
                            </div>
                        </div>
                    \`;

                    function attachUi() {
                        if (!document.getElementById('ag-rtl-toolbar-wrap')) {
                            const cluster = document.querySelector('[data-testid="titlebar-more-actions"]')?.parentElement
                                || document.querySelector('[data-testid="install-editor"]')?.parentElement;
                            if (cluster) cluster.appendChild(wrap);
                        }
                        if (!document.getElementById('ag-rtl-drawer')) {
                            document.body.appendChild(drawer);
                        }
                    }

                    attachUi();

                    const btn = wrap.querySelector('#ag-rtl-toolbar-btn');
                    const dot = wrap.querySelector('#ag-rtl-dot');
                    const statusTxt = drawer.querySelector('#ag-rtl-status-txt');
                    const enableSw = drawer.querySelector('#ag-rtl-enable-sw');
                    const forceRow = drawer.querySelector('#ag-rtl-force-row');
                    const forceSw = drawer.querySelector('#ag-rtl-force-sw');
                    const controls = drawer.querySelector('#ag-rtl-controls');
                    const faIn = drawer.querySelector('#ag-rtl-fa-in');
                    const enIn = drawer.querySelector('#ag-rtl-en-in');
                    const codeIn = drawer.querySelector('#ag-rtl-code-in');
                    const lhIn = drawer.querySelector('#ag-rtl-lh-in');
                    const lhVal = drawer.querySelector('#ag-rtl-lh-val');
                    const lhRst = drawer.querySelector('#ag-rtl-lh-rst');
                    const fsIn = drawer.querySelector('#ag-rtl-fs-in');
                    const fsVal = drawer.querySelector('#ag-rtl-fs-val');
                    const fsRst = drawer.querySelector('#ag-rtl-fs-rst');

                    faIn.value = state.faFont;
                    enIn.value = state.enFont;
                    codeIn.value = state.codeFont;
                    lhIn.value = state.lh;
                    fsIn.value = state.fs;
                    lhVal.textContent = state.lh + '×';
                    fsVal.textContent = state.fs + 'px';

                    function persist() {
                        try {
                            console.log('${SAVE_PREFIX}' + JSON.stringify({
                                faFont: state.faFont,
                                enFont: state.enFont,
                                codeFont: state.codeFont,
                                lh: state.lh,
                                fs: state.fs,
                                isRTL: state.enabled,
                                forceRTL: state.forceRtl
                            }));
                        } catch (_) {}
                    }

                    function syncState(shouldPersist = true) {
                        enableSw.setAttribute('aria-checked', String(state.enabled));
                        forceSw.setAttribute('aria-checked', String(state.forceRtl));
                        statusTxt.textContent = state.enabled ? 'Enabled' : 'Disabled';
                        dot.classList.toggle('off', !state.enabled);
                        forceRow.classList.toggle('muted', !state.enabled);
                        controls.classList.toggle('muted', !state.enabled);

                        renderContentCss();
                        if (state.enabled) {
                            window.__agPersianBidi.updateAll(state.forceRtl, null);
                        } else {
                            window.__agPersianBidi.restoreAll();
                        }
                        if (shouldPersist) persist();
                    }

                    syncState(false);

                    window.__agPersianBidi.observeMutations(
                        () => state,
                        (targetRoot) => {
                            attachUi();
                            if (state.enabled) {
                                window.__agPersianBidi.updateAll(state.forceRtl, targetRoot);
                            }
                        }
                    );

                    window.__agPersianBidi.bindShortcut(() => {
                        state.enabled = !state.enabled;
                        syncState(true);
                    });

                    enableSw.addEventListener('click', () => {
                        state.enabled = !state.enabled;
                        syncState(true);
                    });

                    forceSw.addEventListener('click', () => {
                        if (!state.enabled) return;
                        state.forceRtl = !state.forceRtl;
                        syncState(true);
                    });

                    [faIn, enIn, codeIn].forEach((input, idx) => {
                        const field = idx === 0 ? 'faFont' : idx === 1 ? 'enFont' : 'codeFont';
                        input.addEventListener('input', () => {
                            state[field] = input.value.trim();
                            renderContentCss();
                            persist();
                        });
                    });

                    lhIn.addEventListener('input', () => {
                        state.lh = lhIn.value;
                        lhVal.textContent = state.lh + '×';
                        renderContentCss();
                        persist();
                    });
                    lhRst.addEventListener('click', () => {
                        state.lh = '1.6';
                        lhIn.value = '1.6';
                        lhVal.textContent = '1.6×';
                        renderContentCss();
                        persist();
                    });

                    fsIn.addEventListener('input', () => {
                        state.fs = fsIn.value;
                        fsVal.textContent = state.fs + 'px';
                        renderContentCss();
                        persist();
                    });
                    fsRst.addEventListener('click', () => {
                        state.fs = '16';
                        fsIn.value = '16';
                        fsVal.textContent = '16px';
                        renderContentCss();
                        persist();
                    });

                    function placeDrawer() {
                        const rect = btn.getBoundingClientRect();
                        drawer.style.top = (rect.bottom + 6) + 'px';
                        drawer.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
                    }

                    function setDrawerOpen(next) {
                        const open = next !== undefined ? next : !drawer.classList.contains('open');
                        if (open) placeDrawer();
                        drawer.classList.toggle('open', open);
                        btn.setAttribute('aria-expanded', String(open));
                    }

                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        setDrawerOpen();
                    });
                    drawer.addEventListener('click', (e) => e.stopPropagation());
                    document.addEventListener('click', (e) => {
                        if (drawer.classList.contains('open') && !drawer.contains(e.target) && !btn.contains(e.target)) {
                            setDrawerOpen(false);
                        }
                    });
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape' && drawer.classList.contains('open')) {
                            setDrawerOpen(false);
                        }
                    });
                    window.addEventListener('resize', () => {
                        if (drawer.classList.contains('open')) placeDrawer();
                    });
                }

                let mounted = false;
                let pollTimer = null;
                let bootObserver = null;

                function tryBoot() {
                    if (mounted) return;
                    if (hasAppShell()) {
                        mounted = true;
                        if (pollTimer) clearInterval(pollTimer);
                        if (bootObserver) {
                            try { bootObserver.disconnect(); } catch (_) {}
                        }
                        mountUi();
                    }
                }

                tryBoot();
                if (!mounted) {
                    try {
                        bootObserver = new MutationObserver(tryBoot);
                        bootObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
                    } catch (_) {}
                    pollTimer = setInterval(tryBoot, 250);
                }
            })();`).catch((err) => console.error('Failed to inject clean-room RTL runtime:', err));
            } catch (err) {
                console.error('Failed to load bundled Vazirmatn font:', err);
            }
        });
    }
})(win);
void win.loadURL(url);
/* END ANTIGRAVITY PERSIAN RTL */
