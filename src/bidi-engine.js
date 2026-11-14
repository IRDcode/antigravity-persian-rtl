/**
 * Clean-room bidirectional (BiDi) layout controller for Google Antigravity Desktop.
 * Resolves paragraph direction from natural-language text nodes (ignoring inline code tokens)
 * and tracks managed DOM nodes non-destructively so toggling off restores original attributes.
 */
(() => {
    if (window.__agPersianBidi) return;

    const MANAGED_ATTR = 'data-ag-rtl-managed';
    const PREV_DIR_ATTR = 'data-ag-rtl-prev';
    const UI_CONTAINER_SELECTOR = '[data-ag-rtl-ui]';

    const CODE_SKIP_SELECTOR = 'pre, code, kbd, samp, .monaco-editor, .xterm, .terminal, .cursor-edit, .font-mono';
    const CODE_TAGS = new Set(['PRE', 'CODE', 'KBD', 'SAMP']);
    const PROSE_SELECTOR = [
        '.prose > *',
        '[data-testid="chat-message"] > *',
        '.markdown-body > *',
        '.leading-relaxed > *',
        '[data-testid="user-input-step"]',
        '[data-testid="user-input-step"] > *',
        '[data-testid="conversation-view"] p',
        '[data-testid="conversation-view"] li',
        'div:has(> [role="radiogroup"])',
        'label[for^="ask-opt-"]'
    ].join(', ');
    const INPUT_SELECTOR = [
        '[contenteditable="true"] p',
        '[contenteditable="true"]',
        'textarea[data-testid="ask-question-writein"]'
    ].join(', ');

    const STRIP_NEUTRAL_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
    const RTL_CHAR_RE = /[\u0591-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
    const STRONG_CHAR_RE = /[A-Za-z\u0591-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
    const LEADING_URLS_OR_PATHS_RE = /^(?:(?:https?:\/\/\S+|(?:[A-Za-z]:\\|\/)[^\s\u0600-\u06ff]+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\s*)+/;

    function applyManagedDir(el, nextDir) {
        if (!el || el.nodeType !== 1) return;
        if (!el.hasAttribute(MANAGED_ATTR)) {
            const existing = el.getAttribute('dir');
            el.setAttribute(MANAGED_ATTR, '1');
            el.setAttribute(PREV_DIR_ATTR, existing === null ? '' : existing);
        }
        if (nextDir === null) {
            el.removeAttribute('dir');
        } else if (el.getAttribute('dir') !== nextDir) {
            el.setAttribute('dir', nextDir);
        }
    }

    function isSkippedSubtree(node) {
        if (!node || node.nodeType !== 1) return false;
        if (CODE_TAGS.has(node.tagName)) return true;
        return typeof node.matches === 'function' && node.matches(CODE_SKIP_SELECTOR);
    }

    function extractNaturalText(el) {
        if (!el) return '';
        let collected = '';
        let foundStrongNatural = false;

        function visit(node) {
            if (!node || foundStrongNatural) return;
            if (node.nodeType === 3) {
                if (node.nodeValue) {
                    collected += node.nodeValue + ' ';
                    const candidate = collected
                        .replace(STRIP_NEUTRAL_RE, '')
                        .trim()
                        .replace(LEADING_URLS_OR_PATHS_RE, '')
                        .trim();
                    if (STRONG_CHAR_RE.test(candidate)) {
                        foundStrongNatural = true;
                    }
                }
                return;
            }
            if (node.nodeType === 1) {
                if (node !== el && isSkippedSubtree(node)) return;
                const children = node.childNodes;
                if (children && children.length) {
                    for (let i = 0; i < children.length; i++) {
                        visit(children[i]);
                        if (foundStrongNatural) break;
                    }
                }
            }
        }

        if (el.childNodes && el.childNodes.length) {
            visit(el);
        } else {
            collected = el.textContent || '';
        }

        const clean = collected
            .replace(STRIP_NEUTRAL_RE, '')
            .trim()
            .replace(LEADING_URLS_OR_PATHS_RE, '')
            .trim();
        if (clean.length > 0) return clean;
        return (el.textContent || '').replace(STRIP_NEUTRAL_RE, '').trim();
    }

    function detectDirection(text, forceRtl) {
        if (forceRtl) return 'rtl';
        const firstStrong = text.match(STRONG_CHAR_RE);
        if (!firstStrong) return 'auto';
        return RTL_CHAR_RE.test(firstStrong[0]) ? 'rtl' : 'ltr';
    }

    function detectInputDirection(rawText) {
        const clean = (rawText || '').replace(STRIP_NEUTRAL_RE, '').trim();
        if (!clean) return null;
        const firstStrong = clean.match(STRONG_CHAR_RE);
        if (!firstStrong) return null;
        return RTL_CHAR_RE.test(firstStrong[0]) ? 'rtl' : 'ltr';
    }

    function updateElement(el, forceRtl) {
        if (!el || el.nodeType !== 1) return;
        if (el.tagName === 'PRE' || el.tagName === 'CODE' || el.closest('.monaco-editor') || el.closest('.terminal')) {
            return;
        }
        if (el.closest(UI_CONTAINER_SELECTOR)) return;

        const naturalText = extractNaturalText(el);
        applyManagedDir(el, detectDirection(naturalText, forceRtl));
    }

    function updateAll(forceRtl, rootNode) {
        const scope = rootNode && rootNode.querySelectorAll ? rootNode : document;

        const inputs = scope.querySelectorAll(INPUT_SELECTOR);
        for (let i = 0; i < inputs.length; i++) {
            const el = inputs[i];
            if (el.closest(UI_CONTAINER_SELECTOR)) continue;
            const raw = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
            applyManagedDir(el, detectInputDirection(raw));
        }

        const blocks = scope.querySelectorAll(PROSE_SELECTOR);
        for (let i = 0; i < blocks.length; i++) {
            updateElement(blocks[i], forceRtl);
        }

        if (scope !== document && scope.matches && scope.matches(PROSE_SELECTOR)) {
            updateElement(scope, forceRtl);
        }
    }

    function restoreAll() {
        const managed = document.querySelectorAll('[' + MANAGED_ATTR + ']');
        for (let i = 0; i < managed.length; i++) {
            const el = managed[i];
            const prev = el.getAttribute(PREV_DIR_ATTR);
            if (prev) {
                el.setAttribute('dir', prev);
            } else {
                el.removeAttribute('dir');
            }
            el.removeAttribute(MANAGED_ATTR);
            el.removeAttribute(PREV_DIR_ATTR);
        }
    }

    function isInternalUiNode(node) {
        const el = node && node.nodeType === 3 ? node.parentElement : node;
        return Boolean(el && el.closest && el.closest(UI_CONTAINER_SELECTOR));
    }

    function observeMutations(getState, onExternalChange) {
        let pendingTimer = null;
        let rafPending = false;
        let fullSweepNeeded = false;
        const dirtyRoots = new Set();

        const flush = () => {
            pendingTimer = null;
            const state = getState();
            if (!state.enabled) {
                dirtyRoots.clear();
                fullSweepNeeded = false;
                return;
            }
            if (fullSweepNeeded || dirtyRoots.size > 40) {
                dirtyRoots.clear();
                fullSweepNeeded = false;
                onExternalChange(null);
                return;
            }
            const batch = [...dirtyRoots];
            dirtyRoots.clear();
            for (const target of batch) {
                if (target && target.isConnected) {
                    onExternalChange(target);
                }
            }
        };

        const schedule = (targetNode, forceFull = false) => {
            if (forceFull) {
                fullSweepNeeded = true;
            } else if (targetNode && targetNode.nodeType === 1) {
                dirtyRoots.add(targetNode);
            } else if (targetNode && targetNode.parentElement) {
                dirtyRoots.add(targetNode.parentElement);
            } else {
                fullSweepNeeded = true;
            }

            if (pendingTimer !== null || rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                pendingTimer = setTimeout(flush, 120);
            });
        };

        const onInputOrFocus = (e) => {
            if (!isInternalUiNode(e.target)) {
                schedule(e.target, false);
            }
        };

        document.body.addEventListener('input', onInputOrFocus, { capture: true });
        document.body.addEventListener('focusin', onInputOrFocus, { capture: true });

        const observer = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (isInternalUiNode(m.target)) continue;
                if (m.type === 'characterData') {
                    schedule(m.target, false);
                } else {
                    let foundExternal = false;
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        if (!isInternalUiNode(m.addedNodes[j])) {
                            foundExternal = true;
                            break;
                        }
                    }
                    if (foundExternal) {
                        schedule(m.target, false);
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return () => {
            observer.disconnect();
            document.body.removeEventListener('input', onInputOrFocus, { capture: true });
            document.body.removeEventListener('focusin', onInputOrFocus, { capture: true });
        };
    }

    function bindShortcut(callback) {
        document.addEventListener('keydown', (e) => {
            if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyR') {
                e.preventDefault();
                callback();
            }
        });
    }

    window.__agPersianBidi = {
        updateAll,
        restoreAll,
        observeMutations,
        bindShortcut
    };
})();
