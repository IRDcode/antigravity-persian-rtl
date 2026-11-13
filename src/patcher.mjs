import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PATCH_MARKER = '/* ANTIGRAVITY PERSIAN RTL v1.1 */';
export const PATCH_END = '/* END ANTIGRAVITY PERSIAN RTL */';
export const ANCHOR = 'void win.loadURL(url);';

const CURRENT_BLOCK_RE = /\/\* ANTIGRAVITY PERSIAN RTL[\s\S]*?\/\* END ANTIGRAVITY PERSIAN RTL \*\//;
const HARDENED_BLOCK_RE = /\/\* ANTIGRAVITY RTL HARDENED[\s\S]*?\/\* END ANTIGRAVITY RTL HARDENED \*\//;
const LEGACY_BLOCK_RE = /\/\* (?:ANTIGRAVITY RTL PATCH|FALIZ RTL CORE|FANTIGRAVITY RTL CORE) \*\/[\s\S]*?\/\* END (?:ANTIGRAVITY RTL PATCH|FALIZ RTL CORE|FANTIGRAVITY RTL CORE) \*\//;

const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;
const FONT_REL_PATH = 'dist/Vazirmatn-Variable.woff2';
const UTILS_REL_PATH = 'dist/utils.js';

export class PatchError extends Error {
    constructor(code, message, { causeText = '', fix = '', details = undefined, exitCode = 1 } = {}) {
        super(message);
        this.name = 'PatchError';
        this.code = code;
        this.causeText = causeText;
        this.fix = fix;
        this.details = details;
        this.exitCode = exitCode;
    }
}

export function getCandidateAppAsarPaths() {
    const candidates = [];
    if (process.platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app.asar'));
            candidates.push(path.join(process.env.LOCALAPPDATA, 'Antigravity', 'resources', 'app.asar'));
        }
        if (process.env.PROGRAMFILES) {
            candidates.push(path.join(process.env.PROGRAMFILES, 'Antigravity', 'resources', 'app.asar'));
            candidates.push(path.join(process.env.PROGRAMFILES, 'antigravity', 'resources', 'app.asar'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Antigravity.app/Contents/Resources/app.asar');
        candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'));
    } else {
        candidates.push(
            '/opt/Antigravity/resources/app.asar',
            '/opt/antigravity/resources/app.asar',
            '/usr/lib/antigravity/resources/app.asar',
            path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'app.asar')
        );
    }
    return [...new Set(candidates)];
}

export function getDefaultAppAsarPath() {
    return getCandidateAppAsarPaths().find(p => fs.existsSync(p)) || null;
}

export function resolveAsarTarget(customPath) {
    if (!customPath) {
        return getDefaultAppAsarPath();
    }
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const direct = path.join(resolved, 'app.asar');
        const nested = path.join(resolved, 'resources', 'app.asar');
        if (fs.existsSync(direct)) return direct;
        if (fs.existsSync(nested)) return nested;
    }
    return resolved;
}

function wrapFsError(err, action, targetPath) {
    if (err instanceof PatchError) return err;
    const code = err && err.code;
    if (code === 'EBUSY') {
        return new PatchError('FILE_LOCKED', `Cannot ${action} because ${path.basename(targetPath)} is locked by another process.`, {
            causeText: 'Antigravity Desktop, a tray/helper process, or an antivirus scanner is holding the file handle open.',
            fix: 'Close Antigravity completely (check the Windows System Tray / Task Manager) and retry.',
            details: { path: targetPath, sysCode: code },
            exitCode: 2
        });
    }
    if (code === 'EACCES' || code === 'EPERM') {
        return new PatchError('PERMISSION_DENIED', `Permission denied while attempting to ${action}: ${targetPath}`, {
            causeText: 'The installation directory requires elevated privileges (for example Program Files or a system directory).',
            fix: process.platform === 'win32'
                ? 'Right-click Launch-Antigravity-RTL.bat (or PowerShell) and choose "Run as administrator".'
                : 'Run the command with sufficient permissions (or sudo) for the installation folder.',
            details: { path: targetPath, sysCode: code }
        });
    }
    if (code === 'ENOSPC') {
        return new PatchError('DISK_FULL', `Not enough free disk space to ${action}: ${targetPath}`, {
            causeText: 'Temporary ASAR repacking could not complete because the target drive ran out of free space.',
            fix: 'Free at least 30 MB on the target drive and run the command again. Your original app.asar was not overwritten.',
            details: { path: targetPath, sysCode: code }
        });
    }
    if (code === 'ENOENT') {
        return new PatchError('ASAR_NOT_FOUND', `Target file not found: ${targetPath}`, {
            causeText: 'The expected app.asar file does not exist at this path.',
            fix: 'Verify Antigravity Desktop is installed, or pass --path "<full path to app.asar>".',
            details: { path: targetPath, sysCode: code }
        });
    }
    if (code === 'EROFS') {
        return new PatchError('READ_ONLY_FS', `Target filesystem is read-only: ${targetPath}`, {
            causeText: 'The application resides on a read-only mount or sealed image.',
            fix: 'Install Antigravity Desktop in a writable user/system directory before patching.',
            details: { path: targetPath, sysCode: code }
        });
    }
    return new PatchError('FS_ERROR', `Filesystem failure during ${action}: ${err.message}`, {
        causeText: err.message,
        fix: 'Run the Doctor diagnostic command (`node src/patcher.mjs doctor`) and inspect permissions and disk health.',
        details: { path: targetPath, sysCode: code }
    });
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function isAntigravityRunningForAsar(asarPath) {
    if (!asarPath) return false;
    if (process.platform !== 'win32') return false;
    const expectedExe = path.resolve(path.dirname(asarPath), '..', 'Antigravity.exe').toLowerCase();
    try {
        const out = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-Command',
                "Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"
            ],
            { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        return out
            .split(/\r?\n/)
            .map(l => l.trim().toLowerCase())
            .filter(Boolean)
            .some(p => p === expectedExe);
    } catch {
        return false;
    }
}

function computeAsarIntegrity(data) {
    const hash = crypto.createHash('SHA256').update(data).digest('hex');
    const blocks = [];
    for (let offset = 0; offset < data.length; offset += ASAR_BLOCK_SIZE) {
        const end = Math.min(offset + ASAR_BLOCK_SIZE, data.length);
        blocks.push(crypto.createHash('SHA256').update(data.subarray(offset, end)).digest('hex'));
    }
    if (data.length === 0) {
        blocks.push(crypto.createHash('SHA256').update(data).digest('hex'));
    }
    return { algorithm: 'SHA256', hash, blockSize: ASAR_BLOCK_SIZE, blocks };
}

function encodeAsarPickleHeader(headerObj) {
    const jsonStr = JSON.stringify(headerObj);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');
    const alignedLen = jsonBuf.length + ((4 - (jsonBuf.length % 4)) % 4);
    const headerPayloadLen = 4 + alignedLen;

    const headerPickle = Buffer.alloc(4 + headerPayloadLen);
    headerPickle.writeUInt32LE(headerPayloadLen, 0);
    headerPickle.writeInt32LE(jsonBuf.length, 4);
    jsonBuf.copy(headerPickle, 8);

    const sizePickle = Buffer.alloc(8);
    sizePickle.writeUInt32LE(4, 0);
    sizePickle.writeUInt32LE(headerPickle.length, 4);
    return Buffer.concat([sizePickle, headerPickle]);
}

function readUtilsFromAsar(asarPath) {
    asar.uncache(asarPath);
    asar.getRawHeader(asarPath);
    return asar.extractFile(asarPath, UTILS_REL_PATH).toString('utf8');
}

function readAppVersionFromAsar(asarPath) {
    try {
        asar.uncache(asarPath);
        const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
        return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
        return null;
    }
}

function hasAsarEntry(asarPath, relPath) {
    try {
        asar.uncache(asarPath);
        const info = asar.statFile(asarPath, relPath);
        return Boolean(info && 'size' in info);
    } catch {
        return false;
    }
}

function hasAnyRtlComment(code) {
    return (
        code.includes('/* ANTIGRAVITY PERSIAN RTL') ||
        code.includes('/* ANTIGRAVITY RTL') ||
        code.includes('/* FALIZ RTL') ||
        code.includes('/* FANTIGRAVITY RTL')
    );
}

function stripAnyPatch(code) {
    if (CURRENT_BLOCK_RE.test(code)) return code.replace(CURRENT_BLOCK_RE, ANCHOR);
    if (HARDENED_BLOCK_RE.test(code)) return code.replace(HARDENED_BLOCK_RE, ANCHOR);
    if (LEGACY_BLOCK_RE.test(code)) return code.replace(LEGACY_BLOCK_RE, ANCHOR);
    return null;
}

function inspectBackup(backupPath) {
    if (!fs.existsSync(backupPath)) {
        return { exists: false, state: 'none' };
    }
    try {
        const utils = readUtilsFromAsar(backupPath);
        new vm.Script(utils, { filename: 'backup:dist/utils.js' });
        if (hasAnyRtlComment(utils) || hasAsarEntry(backupPath, FONT_REL_PATH)) {
            return { exists: true, state: 'patched' };
        }
        return { exists: true, state: 'clean' };
    } catch (err) {
        return { exists: true, state: 'corrupt', error: err.message };
    }
}

export function getPatchStatus(asarPath) {
    const checkedPaths = asarPath ? [asarPath] : getCandidateAppAsarPaths();
    if (!asarPath || !fs.existsSync(asarPath)) {
        return {
            exists: false,
            state: 'missing',
            running: false,
            hasBackup: false,
            backupState: 'none',
            checkedPaths
        };
    }

    try {
        if (fs.statSync(asarPath).isDirectory()) {
            return {
                exists: false,
                state: 'not_a_file',
                asarPath,
                running: false,
                hasBackup: false,
                backupState: 'none'
            };
        }
        const utils = readUtilsFromAsar(asarPath);
        const hasFont = hasAsarEntry(asarPath, FONT_REL_PATH);
        let state = 'unpatched';
        if (utils.includes(PATCH_MARKER) && hasFont) {
            state = 'patched';
        } else if (hasAnyRtlComment(utils)) {
            state = 'legacy_or_stale';
        }
        const backupInfo = inspectBackup(`${asarPath}.bak`);
        return {
            exists: true,
            asarPath,
            appVersion: readAppVersionFromAsar(asarPath),
            state,
            hasFont,
            hasAnchor: utils.includes(ANCHOR) || state !== 'unpatched',
            hasBackup: backupInfo.exists,
            backupState: backupInfo.state,
            running: isAntigravityRunningForAsar(asarPath)
        };
    } catch (err) {
        const backupInfo = inspectBackup(`${asarPath}.bak`);
        return {
            exists: true,
            asarPath,
            state: 'corrupt',
            corruptReason: err.message,
            hasFont: false,
            hasAnchor: false,
            hasBackup: backupInfo.exists,
            backupState: backupInfo.state,
            running: isAntigravityRunningForAsar(asarPath)
        };
    }
}

/**
 * Rebuilds an ASAR archive cleanly without touching unpacked files on disk.
 * Preserves existing unpacked entries, links, executable bits, and offset deduplication.
 */
function rebuildAsarWithOverrides(srcAsarPath, destTmpPath, overrides, removals = new Set()) {
    const raw = asar.getRawHeader(srcAsarPath);
    const dataStart = 8 + raw.headerSize;
    const totalSize = fs.statSync(srcAsarPath).size;
    const origDataSize = totalSize - dataStart;
    if (origDataSize < 0) {
        throw new PatchError('CORRUPT_ASAR', `Corrupt ASAR archive header in ${srcAsarPath}.`, {
            causeText: 'ASAR headerSize exceeds total file size.',
            fix: 'Run `restore` if a clean .bak backup exists, or reinstall Antigravity Desktop.'
        });
    }
    const origDataBuf = Buffer.alloc(origDataSize);
    const fd = fs.openSync(srcAsarPath, 'r');
    try {
        let pos = 0;
        while (pos < origDataSize) {
            const n = fs.readSync(fd, origDataBuf, pos, origDataSize - pos, dataStart + pos);
            if (n <= 0) break;
            pos += n;
        }
    } finally {
        fs.closeSync(fd);
    }

    const headerClone = structuredClone(raw.header);
    const pendingOverrides = new Map(Object.entries(overrides));
    const chunks = [];
    let nextOffset = 0;
    const dedupOffsets = new Map();

    function processDirectory(dirNode, prefix) {
        for (const [name, entry] of Object.entries(dirNode.files)) {
            const relPath = prefix ? `${prefix}/${name}` : name;
            if (removals.has(relPath)) {
                delete dirNode.files[name];
                continue;
            }
            if ('link' in entry) {
                continue;
            }
            if ('files' in entry) {
                processDirectory(entry, relPath);
                continue;
            }
            if (entry.unpacked) {
                continue;
            }
            if (pendingOverrides.has(relPath)) {
                const buf = pendingOverrides.get(relPath);
                pendingOverrides.delete(relPath);
                entry.offset = String(nextOffset);
                entry.size = buf.length;
                entry.integrity = computeAsarIntegrity(buf);
                chunks.push(buf);
                nextOffset += buf.length;
                continue;
            }
            if (entry.size <= 0) {
                entry.offset = '0';
                continue;
            }
            const dedupKey = `${entry.offset}:${entry.size}`;
            if (dedupOffsets.has(dedupKey)) {
                entry.offset = dedupOffsets.get(dedupKey);
                continue;
            }
            const origOff = Number(entry.offset);
            if (!Number.isFinite(origOff) || origOff + entry.size > origDataBuf.length) {
                throw new PatchError('CORRUPT_ASAR', `Entry "${relPath}" points outside archive data bounds.`, {
                    causeText: 'ASAR internal table is truncated or damaged.',
                    fix: 'Run `restore` if app.asar.bak is clean, otherwise reinstall Antigravity Desktop.'
                });
            }
            const slice = origDataBuf.subarray(origOff, origOff + entry.size);
            const assigned = String(nextOffset);
            dedupOffsets.set(dedupKey, assigned);
            entry.offset = assigned;
            chunks.push(slice);
            nextOffset += slice.length;
        }
    }

    processDirectory(headerClone, '');

    for (const [relPath, buf] of pendingOverrides.entries()) {
        const parts = relPath.split('/');
        const fileName = parts.pop();
        let cursor = headerClone;
        for (const seg of parts) {
            if (!cursor.files[seg]) {
                cursor.files[seg] = { files: Object.create(null) };
            }
            cursor = cursor.files[seg];
        }
        cursor.files[fileName] = {
            offset: String(nextOffset),
            size: buf.length,
            integrity: computeAsarIntegrity(buf)
        };
        chunks.push(buf);
        nextOffset += buf.length;
    }

    const headerBuf = encodeAsarPickleHeader(headerClone);
    const outFd = fs.openSync(destTmpPath, 'w');
    try {
        fs.writeSync(outFd, headerBuf);
        for (const c of chunks) {
            if (c.length > 0) fs.writeSync(outFd, c);
        }
    } finally {
        fs.closeSync(outFd);
    }
}

function readBundleAssets() {
    const enginePath = path.join(__dirname, 'bidi-engine.js');
    const runtimePath = path.join(__dirname, 'runtime-patch.js');
    const fontPath = path.join(__dirname, 'Vazirmatn-Variable.woff2');
    for (const reqPath of [enginePath, runtimePath, fontPath]) {
        if (!fs.existsSync(reqPath)) {
            throw new PatchError('MISSING_BUNDLE_ASSET', `Required patcher asset missing: ${path.basename(reqPath)}`, {
                causeText: `Expected file at ${reqPath} was deleted or incomplete.`,
                fix: 'Re-clone or re-extract the complete antigravity-persian-rtl package.'
            });
        }
    }
    return {
        engineCode: fs.readFileSync(enginePath, 'utf8'),
        runtimeTemplate: fs.readFileSync(runtimePath, 'utf8'),
        fontBuf: fs.readFileSync(fontPath)
    };
}

export function buildInjectedUtils(cleanUtilsCode) {
    if (!cleanUtilsCode.includes(ANCHOR)) {
        throw new PatchError('ANCHOR_NOT_FOUND', `Injection anchor "${ANCHOR}" not found in ${UTILS_REL_PATH}.`, {
            causeText: 'This Antigravity release changed the internal startup hook inside dist/utils.js.',
            fix: 'Your original app.asar was NOT modified. Check for an updated release or report your Antigravity version on GitHub Issues.'
        });
    }
    const { engineCode, runtimeTemplate } = readBundleAssets();
    const runtimeCode = runtimeTemplate.replace('__BIDI_ENGINE__', () => JSON.stringify(engineCode));
    const injected = cleanUtilsCode.replace(ANCHOR, () => runtimeCode.trimEnd());
    try {
        new vm.Script(injected, { filename: UTILS_REL_PATH });
    } catch (err) {
        throw new PatchError('SCRIPT_SYNTAX_ERROR', `Generated payload failed JavaScript syntax verification: ${err.message}`, {
            causeText: err.message,
            fix: 'Your original app.asar was NOT modified. Verify src/runtime-patch.js and src/bidi-engine.js are uncorrupted.'
        });
    }
    return injected;
}

function assertValidAsarTarget(asarPath) {
    if (!asarPath) {
        throw new PatchError('ASAR_NOT_FOUND', 'Could not locate Antigravity Desktop app.asar automatically.', {
            causeText: 'None of the standard Antigravity Desktop installation paths contained resources/app.asar.',
            fix: 'Pass the exact path explicitly: `node src/patcher.mjs patch --path "C:\\path\\to\\resources\\app.asar"`',
            details: { checkedPaths: getCandidateAppAsarPaths() }
        });
    }
    if (!fs.existsSync(asarPath)) {
        throw new PatchError('ASAR_NOT_FOUND', `app.asar not found at: ${asarPath}`, {
            causeText: 'The specified or default Antigravity app.asar path does not exist.',
            fix: 'Verify Antigravity Desktop is installed, or pass `--path "<full path to app.asar>"`.'
        });
    }
    if (fs.statSync(asarPath).isDirectory()) {
        throw new PatchError('PATH_NOT_FILE', `Expected an app.asar file path, got a directory: ${asarPath}`, {
            causeText: 'The target path points to a directory rather than an app.asar file.',
            fix: 'Pass the full path ending in `app.asar` (e.g. `...\\resources\\app.asar`).'
        });
    }
}

export function patchAsar(asarPath, { ifNeeded = false } = {}) {
    assertValidAsarTarget(asarPath);

    const status = getPatchStatus(asarPath);
    if (status.state === 'corrupt') {
        if (status.hasBackup && status.backupState === 'clean') {
            throw new PatchError('CORRUPT_ASAR', `app.asar appears corrupted (${status.corruptReason}), but a clean .bak exists.`, {
                causeText: status.corruptReason,
                fix: 'Run `node src/patcher.mjs restore` first to roll back to your clean backup, then run `patch`.'
            });
        }
        throw new PatchError('CORRUPT_ASAR', `Cannot read app.asar (${status.corruptReason}).`, {
            causeText: status.corruptReason,
            fix: 'Reinstall Antigravity Desktop cleanly before applying the RTL patch.'
        });
    }
    if (ifNeeded && status.state === 'patched') {
        return { changed: false, status: 'already_patched', asarPath, appVersion: status.appVersion || null };
    }
    if (status.running) {
        throw new PatchError('ANTIGRAVITY_RUNNING', 'Antigravity.exe is currently running and holding app.asar open.', {
            causeText: 'Windows locks open ASAR files while the Electron app or its System Tray process is running.',
            fix: 'Quit Antigravity completely (check System Tray) or launch via Launch-Antigravity-RTL.bat.',
            exitCode: 2
        });
    }

    try {
        fs.accessSync(path.dirname(asarPath), fs.constants.W_OK);
    } catch (err) {
        throw wrapFsError(err, 'access installation folder', asarPath);
    }

    const backupPath = `${asarPath}.bak`;
    let currentUtils;
    try {
        currentUtils = readUtilsFromAsar(asarPath);
    } catch (err) {
        throw wrapFsError(err, 'read app.asar', asarPath);
    }

    const backupInfo = inspectBackup(backupPath);
    let cleanUtils;
    let needBackupFromCleanBuild = false;

    if (status.state === 'unpatched') {
        cleanUtils = currentUtils;
    } else {
        let backupUtils = null;
        if (backupInfo.state === 'clean') {
            backupUtils = readUtilsFromAsar(backupPath);
        }
        cleanUtils = stripAnyPatch(currentUtils) ?? backupUtils;
        if (!cleanUtils) {
            throw new PatchError(
                'LEGACY_PATCH_UNRECOVERABLE',
                'Existing RTL modification cannot be stripped cleanly and no clean app.asar.bak exists.',
                {
                    causeText: 'A third-party patcher modified dist/utils.js without an exact removable block or clean backup.',
                    fix: 'Reinstall official Antigravity Desktop (user data & chats remain untouched), then run this patcher.'
                }
            );
        }
        needBackupFromCleanBuild = backupInfo.state !== 'clean';
    }

    // Build and verify payload syntax BEFORE touching disk or creating .bak.
    const injectedUtils = buildInjectedUtils(cleanUtils);
    const { fontBuf } = readBundleAssets();

    if (status.state === 'unpatched') {
        try {
            const bakTmp = `${backupPath}.tmp-${process.pid}`;
            fs.copyFileSync(asarPath, bakTmp);
            fs.renameSync(bakTmp, backupPath);
        } catch (err) {
            throw wrapFsError(err, 'create backup app.asar.bak', backupPath);
        }
    } else if (needBackupFromCleanBuild) {
        const bakTmp = `${backupPath}.tmp-${process.pid}`;
        try {
            rebuildAsarWithOverrides(
                asarPath,
                bakTmp,
                { [UTILS_REL_PATH]: Buffer.from(cleanUtils, 'utf8') },
                new Set([FONT_REL_PATH])
            );
            asar.uncache(bakTmp);
            asar.getRawHeader(bakTmp);
            fs.renameSync(bakTmp, backupPath);
        } catch (err) {
            asar.uncache(bakTmp);
            fs.rmSync(bakTmp, { force: true });
            throw wrapFsError(err, 'repair clean backup app.asar.bak', backupPath);
        }
    }

    const tmpPath = `${asarPath}.tmp-${process.pid}`;
    try {
        rebuildAsarWithOverrides(asarPath, tmpPath, {
            [UTILS_REL_PATH]: Buffer.from(injectedUtils, 'utf8'),
            [FONT_REL_PATH]: fontBuf
        });

        // Verify repacked archive reads back cleanly before replacing app.asar.
        asar.uncache(tmpPath);
        asar.getRawHeader(tmpPath);
        const verifiedUtils = asar.extractFile(tmpPath, UTILS_REL_PATH).toString('utf8');
        new vm.Script(verifiedUtils, { filename: UTILS_REL_PATH });
        const verifiedFont = asar.extractFile(tmpPath, FONT_REL_PATH);
        if (!verifiedUtils.includes(PATCH_MARKER) || !verifiedFont.equals(fontBuf)) {
            throw new PatchError('POST_PACK_VERIFY_FAILED', 'Post-pack ASAR verification failed.', {
                causeText: 'Extracted utils.js or Vazirmatn-Variable.woff2 in the staged ASAR did not match expected contents.',
                fix: 'Your original app.asar was NOT overwritten. Retry once or verify disk health.'
            });
        }

        try {
            fs.copyFileSync(tmpPath, asarPath);
            asar.uncache(asarPath);
        } catch (writeErr) {
            let rolledBack = false;
            if (inspectBackup(backupPath).state === 'clean') {
                try {
                    fs.copyFileSync(backupPath, asarPath);
                    asar.uncache(asarPath);
                    rolledBack = true;
                } catch {}
            }
            const wrapped = wrapFsError(writeErr, 'write patched app.asar', asarPath);
            if (!rolledBack) {
                wrapped.fix = `CRITICAL: Partial write occurred. Manually copy "${backupPath}" over "${asarPath}", or reinstall Antigravity Desktop.`;
            } else {
                wrapped.causeText += ' Automatic rollback restored the original app.asar cleanly.';
            }
            throw wrapped;
        }

        return {
            changed: true,
            status: 'patched',
            asarPath,
            backupPath,
            appVersion: status.appVersion || null
        };
    } catch (err) {
        throw wrapFsError(err, 'patch app.asar', asarPath);
    } finally {
        asar.uncache(tmpPath);
        fs.rmSync(tmpPath, { force: true });
    }
}

export function restoreAsar(asarPath, { strictBackup = false } = {}) {
    assertValidAsarTarget(asarPath);

    if (isAntigravityRunningForAsar(asarPath)) {
        throw new PatchError('ANTIGRAVITY_RUNNING', 'Antigravity.exe is currently running and holding app.asar open.', {
            causeText: 'Windows locks open ASAR files while the Electron app or its System Tray process is running.',
            fix: 'Quit Antigravity completely (check System Tray / Task Manager) before restoring.',
            exitCode: 2
        });
    }

    const backupPath = `${asarPath}.bak`;
    const backupInfo = inspectBackup(backupPath);
    const status = getPatchStatus(asarPath);

    // 1. Primary path: byte-exact restoration from verified unpatched app.asar.bak.
    if (backupInfo.state === 'clean') {
        try {
            const bakHash = sha256File(backupPath);
            fs.copyFileSync(backupPath, asarPath);
            asar.uncache(asarPath);
            const restoredHash = sha256File(asarPath);
            if (restoredHash !== bakHash) {
                throw new PatchError('RESTORE_VERIFY_FAILED', 'Restored app.asar SHA-256 did not match backup.', {
                    causeText: 'File copy verification mismatch after restoring backup.',
                    fix: `Backup is still safe at "${backupPath}". Retry after freeing disk space or closing file scanners.`
                });
            }
            fs.unlinkSync(backupPath);
            return { restored: true, mode: 'exact_backup', asarPath, sha256: restoredHash };
        } catch (err) {
            throw wrapFsError(err, 'restore from app.asar.bak', asarPath);
        }
    }

    // 2. If already unpatched and no usable clean backup exists.
    if (status.state === 'unpatched') {
        if (backupInfo.exists && backupInfo.state === 'patched') {
            fs.rmSync(backupPath, { force: true });
        }
        return {
            restored: false,
            mode: 'already_original',
            asarPath,
            message: 'Antigravity app.asar is already in its original unpatched state.'
        };
    }

    // 3. Fallback path: strip injected patch cleanly if backup is missing or polluted.
    if (!strictBackup && (status.state === 'patched' || status.state === 'legacy_or_stale')) {
        const currentUtils = readUtilsFromAsar(asarPath);
        const cleanUtils = stripAnyPatch(currentUtils);
        if (cleanUtils) {
            new vm.Script(cleanUtils, { filename: UTILS_REL_PATH });
            const tmpPath = `${asarPath}.restore-${process.pid}`;
            try {
                rebuildAsarWithOverrides(
                    asarPath,
                    tmpPath,
                    { [UTILS_REL_PATH]: Buffer.from(cleanUtils, 'utf8') },
                    new Set([FONT_REL_PATH])
                );
                asar.uncache(tmpPath);
                const verifiedUtils = asar.extractFile(tmpPath, UTILS_REL_PATH).toString('utf8');
                if (hasAnyRtlComment(verifiedUtils) || hasAsarEntry(tmpPath, FONT_REL_PATH)) {
                    throw new PatchError('RESTORE_VERIFY_FAILED', 'Fallback strip verification failed.', {
                        causeText: 'RTL artifacts remained after strip rebuild.',
                        fix: 'Reinstall Antigravity Desktop cleanly.'
                    });
                }
                fs.copyFileSync(tmpPath, asarPath);
                asar.uncache(asarPath);
                if (backupInfo.exists) {
                    fs.rmSync(backupPath, { force: true });
                }
                return {
                    restored: true,
                    mode: 'strip_fallback',
                    asarPath,
                    warning: 'Original app.asar.bak was missing or already patched; cleanly stripped the injected RTL payload instead.'
                };
            } catch (err) {
                throw wrapFsError(err, 'rebuild unpatched app.asar', asarPath);
            } finally {
                asar.uncache(tmpPath);
                fs.rmSync(tmpPath, { force: true });
            }
        }
    }

    if (backupInfo.state === 'patched') {
        throw new PatchError('PATCHED_BACKUP', 'Backup file (app.asar.bak) is itself patched and current patch cannot be stripped cleanly.', {
            causeText: 'A third-party script overwrote app.asar.bak with an already-patched archive.',
            fix: 'Reinstall official Antigravity Desktop (user workspaces & chats in %APPDATA% remain intact).'
        });
    }
    if (backupInfo.state === 'corrupt') {
        throw new PatchError('CORRUPT_BACKUP', `Backup file is corrupted (${backupInfo.error}) and automatic strip could not safely proceed.`, {
            causeText: backupInfo.error,
            fix: 'Reinstall official Antigravity Desktop.'
        });
    }
    throw new PatchError('NO_BACKUP', `No clean backup found at: ${backupPath}`, {
        causeText: 'app.asar.bak is missing and the current modification cannot be stripped automatically.',
        fix: 'Reinstall official Antigravity Desktop (your conversations and settings in %APPDATA% are preserved).'
    });
}

export function runDoctor(asarPath) {
    const checks = [];
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    checks.push({
        id: 'node_runtime',
        status: nodeMajor >= 20 ? 'PASS' : 'FAIL',
        detail: `Node.js v${process.versions.node} (${process.platform}/${process.arch})`,
        fix: nodeMajor >= 20 ? '' : 'Install Node.js 20+ (recommended 22 LTS) from https://nodejs.org/'
    });

    const configPath = path.join(os.homedir(), '.antigravity-rtl.json');
    if (!fs.existsSync(configPath)) {
        checks.push({
            id: 'user_config',
            status: 'PASS',
            detail: `No custom config yet (${configPath}); safe defaults will be used.`
        });
    } else {
        try {
            JSON.parse(fs.readFileSync(configPath, 'utf8'));
            checks.push({
                id: 'user_config',
                status: 'PASS',
                detail: `Valid JSON config at ${configPath}`
            });
        } catch (err) {
            checks.push({
                id: 'user_config',
                status: 'WARN',
                detail: `Malformed JSON at ${configPath} (${err.message}); patcher will fall back to defaults.`,
                fix: `Delete or fix ${configPath}`
            });
        }
    }

    try {
        readBundleAssets();
        checks.push({ id: 'bundle_assets', status: 'PASS', detail: 'bidi-engine.js, runtime-patch.js, and Vazirmatn-Variable.woff2 present.' });
    } catch (err) {
        checks.push({ id: 'bundle_assets', status: 'FAIL', detail: err.message, fix: err.fix });
    }

    const st = getPatchStatus(asarPath);
    if (!st.exists) {
        checks.push({
            id: 'asar_target',
            status: 'FAIL',
            detail: asarPath ? `app.asar not found at ${asarPath}` : 'Antigravity Desktop app.asar not detected in standard locations.',
            fix: 'Install Antigravity Desktop or pass `--path "C:\\path\\to\\resources\\app.asar"`.'
        });
    } else if (st.state === 'corrupt') {
        checks.push({
            id: 'asar_target',
            status: 'FAIL',
            detail: `Corrupt app.asar at ${asarPath}: ${st.corruptReason}`,
            fix: st.backupState === 'clean' ? 'Run `node src/patcher.mjs restore`.' : 'Reinstall Antigravity Desktop.'
        });
    } else {
        checks.push({
            id: 'asar_target',
            status: 'PASS',
            detail: `Found Antigravity${st.appVersion ? ' v' + st.appVersion : ''} (${asarPath}) — state: ${st.state}`
        });
        checks.push({
            id: 'anchor_check',
            status: st.hasAnchor ? 'PASS' : 'FAIL',
            detail: st.hasAnchor ? `Startup hook "${ANCHOR}" verified.` : `Missing expected hook "${ANCHOR}" in ${UTILS_REL_PATH}.`,
            fix: st.hasAnchor ? '' : 'Report your Antigravity version on GitHub Issues.'
        });
        checks.push({
            id: 'backup_health',
            status: st.backupState === 'corrupt' || st.backupState === 'patched' ? 'WARN' : 'PASS',
            detail: `Backup (.bak) state: ${st.backupState}`,
            fix: st.backupState === 'clean' ? '' : (st.state === 'patched' ? 'Re-running patch or restore will rebuild clean state.' : '')
        });
        checks.push({
            id: 'process_lock',
            status: st.running ? 'WARN' : 'PASS',
            detail: st.running ? 'Antigravity.exe is currently running (close before patching/restoring).' : 'No locking Antigravity.exe process detected.',
            fix: st.running ? 'Close Antigravity (and System Tray icon) or use Launch-Antigravity-RTL.bat.' : ''
        });
    }

    const hasFail = checks.some(c => c.status === 'FAIL');
    const hasWarn = checks.some(c => c.status === 'WARN');
    return {
        healthy: !hasFail,
        overall: hasFail ? 'FAIL' : (hasWarn ? 'WARN' : 'PASS'),
        asarStatus: st,
        checks
    };
}

function parseCliArgs(argv) {
    const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
    let customPath = null;
    const idx = argv.indexOf('--path');
    if (idx !== -1) {
        if (!argv[idx + 1] || argv[idx + 1].startsWith('-')) {
            throw new PatchError('MISSING_PATH_VALUE', 'Flag `--path` requires a file path argument.', {
                causeText: 'No path was supplied after `--path`.',
                fix: 'Example: `node src/patcher.mjs status --path "C:\\path\\to\\resources\\app.asar"`'
            });
        }
        customPath = argv[idx + 1];
    }
    return {
        cmd,
        ifNeeded: argv.includes('--if-needed'),
        strictBackup: argv.includes('--strict-backup'),
        json: argv.includes('--json'),
        asarPath: resolveAsarTarget(customPath)
    };
}

function formatErrorText(err) {
    const code = err.code || 'ERROR';
    const lines = [`[antigravity-persian-rtl] ERROR (${code}): ${err.message}`];
    if (err.causeText) lines.push(`  Cause: ${err.causeText}`);
    if (err.fix) lines.push(`  Fix:   ${err.fix}`);
    return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    let opts = { json: process.argv.includes('--json') };
    try {
        opts = parseCliArgs(process.argv.slice(2));
        let result;
        if (opts.cmd === 'status') {
            result = getPatchStatus(opts.asarPath);
        } else if (opts.cmd === 'doctor') {
            result = runDoctor(opts.asarPath);
        } else if (opts.cmd === 'patch') {
            result = patchAsar(opts.asarPath, { ifNeeded: opts.ifNeeded });
        } else if (opts.cmd === 'restore') {
            result = restoreAsar(opts.asarPath, { strictBackup: opts.strictBackup });
        } else {
            throw new PatchError('INVALID_COMMAND', `Unknown command: ${opts.cmd}`, {
                causeText: 'Unsupported CLI subcommand.',
                fix: 'Use one of: `status` | `doctor` | `patch [--if-needed]` | `restore [--strict-backup]`'
            });
        }

        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else if (opts.cmd === 'doctor') {
            console.log(`[antigravity-persian-rtl] doctor: ${result.overall}`);
            for (const c of result.checks) {
                console.log(`  [${c.status}] ${c.id}: ${c.detail}`);
                if (c.fix) console.log(`         -> Fix: ${c.fix}`);
            }
        } else {
            console.log(`[antigravity-persian-rtl] ${opts.cmd}: ${JSON.stringify(result)}`);
        }
        if (opts.cmd === 'doctor' && !result.healthy) {
            process.exit(1);
        }
    } catch (err) {
        if (opts.json) {
            console.error(JSON.stringify({
                error: err.message,
                code: err.code || 'ERROR',
                cause: err.causeText || '',
                fix: err.fix || '',
                details: err.details
            }, null, 2));
        } else {
            console.error(formatErrorText(err));
        }
        process.exit(err.exitCode || 1);
    }
}
