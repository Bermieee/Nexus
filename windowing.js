const PREFIX = 'tv2:window:';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function interactiveTarget(target) { return !!target?.closest?.('button,input,select,textarea,a,summary,details,label'); }

export function centerDraggableWindow(panel, { storageKey = null, clearStored = false } = {}) {
    if (!panel) return false;
    panel.classList.remove('tv2-window-floating', 'tv2-window-dragging');
    delete panel.dataset.tv2Floating;
    panel.style.removeProperty('left');
    panel.style.removeProperty('top');
    if (clearStored && storageKey) {
        try { sessionStorage.removeItem(`${PREFIX}${storageKey}`); } catch {}
    }
    return true;
}

export function makeDraggableWindow(panel, {
    handle = panel?.querySelector?.('.tv2-panel-head,.tv2-tree-classic-toolbar'),
    storageKey = panel?.className || 'window',
    resizable = false,
    minWidth = 420,
    minHeight = 300,
    persistSize = false,
    edgeResizeHandles = false,
} = {}) {
    if (!panel || !handle || panel.dataset.tv2Draggable === 'true') return () => {};
    panel.dataset.tv2Draggable = 'true';
    handle.classList.add('tv2-window-drag-handle');
    const key = `${PREFIX}${storageKey}`;
    if (resizable) {
        panel.classList.add('tv2-resizable-window');
        panel.style.setProperty('--tv2-window-min-width', `${Math.max(280, Number(minWidth) || 420)}px`);
        panel.style.setProperty('--tv2-window-min-height', `${Math.max(200, Number(minHeight) || 300)}px`);
    }

    const savePlacement = () => {
        if (panel.dataset.tv2WindowTransientSize === 'true') return;
        const r = panel.getBoundingClientRect();
        const payload = { left: Math.round(r.left), top: Math.round(r.top) };
        if (resizable && persistSize) { payload.width = Math.round(r.width); payload.height = Math.round(r.height); }
        try { sessionStorage.setItem(key, JSON.stringify(payload)); } catch {}
    };

    const clampCurrent = () => {
        if (panel.dataset.tv2Floating !== 'true') return;
        const r = panel.getBoundingClientRect();
        const left = clamp(r.left, 0, Math.max(0, window.innerWidth - Math.min(r.width, window.innerWidth)));
        const top = clamp(r.top, 0, Math.max(0, window.innerHeight - Math.min(r.height, window.innerHeight)));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    };

    try {
        const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
            panel.classList.add('tv2-window-floating');
            panel.dataset.tv2Floating = 'true';
            panel.style.left = `${saved.left}px`;
            panel.style.top = `${saved.top}px`;
            requestAnimationFrame(clampCurrent);
        }
        if (resizable && persistSize && Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) {
            panel.style.width = `${Math.min(saved.width, window.innerWidth)}px`;
            panel.style.height = `${Math.min(saved.height, window.innerHeight)}px`;
        }
    } catch { /* session-only placement is optional */ }

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    let pointerId = null;

    const onDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (interactiveTarget(event.target)) return;
        const rect = panel.getBoundingClientRect();
        dragging = true;
        pointerId = event.pointerId;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        panel.classList.add('tv2-window-floating', 'tv2-window-dragging');
        panel.dataset.tv2Floating = 'true';
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        try { handle.setPointerCapture(pointerId); } catch {}
        event.preventDefault();
    };

    const onMove = event => {
        if (!dragging || event.pointerId !== pointerId) return;
        const rect = panel.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - Math.min(rect.width, window.innerWidth));
        const maxTop = Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));
        panel.style.left = `${clamp(event.clientX - offsetX, 0, maxLeft)}px`;
        panel.style.top = `${clamp(event.clientY - offsetY, 0, maxTop)}px`;
    };

    const finish = event => {
        if (!dragging || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
        dragging = false;
        panel.classList.remove('tv2-window-dragging');
        try { handle.releasePointerCapture(pointerId); } catch {}
        pointerId = null;
        savePlacement();
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    const resizeHandles = [];
    let activeResize = null;
    const resizeMove = event => {
        if (!activeResize || event.pointerId !== activeResize.pointerId) return;
        const dx = event.clientX - activeResize.startX;
        const dy = event.clientY - activeResize.startY;
        const minW = Math.max(280, Number(minWidth) || 420);
        const minH = Math.max(200, Number(minHeight) || 300);
        let { left, top, width, height } = activeResize;
        const right = activeResize.left + activeResize.width;
        const bottom = activeResize.top + activeResize.height;
        const dir = activeResize.dir;

        if (dir.includes('e')) width = clamp(activeResize.width + dx, minW, Math.max(minW, window.innerWidth - activeResize.left));
        if (dir.includes('s')) height = clamp(activeResize.height + dy, minH, Math.max(minH, window.innerHeight - activeResize.top));
        if (dir.includes('w')) {
            left = clamp(activeResize.left + dx, 0, right - minW);
            width = right - left;
        }
        if (dir.includes('n')) {
            top = clamp(activeResize.top + dy, 0, bottom - minH);
            height = bottom - top;
        }

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
    };
    const resizeFinish = event => {
        if (!activeResize || (event?.pointerId !== undefined && event.pointerId !== activeResize.pointerId)) return;
        const target = activeResize.handle;
        try { target.releasePointerCapture(activeResize.pointerId); } catch {}
        activeResize = null;
        panel.classList.remove('tv2-window-resizing');
        savePlacement();
    };
    if (resizable && edgeResizeHandles) {
        panel.classList.add('tv2-custom-resize-window');
        for (const dir of ['n','e','s','w','ne','nw','se','sw']) {
            const grip = document.createElement('div');
            grip.className = `tv2-window-resize-grip tv2-window-resize-${dir}`;
            grip.dataset.tv2Resize = dir;
            grip.setAttribute('aria-hidden','true');
            const start = event => {
                if (event.button !== undefined && event.button !== 0) return;
                const rect = panel.getBoundingClientRect();
                panel.classList.add('tv2-window-floating','tv2-window-resizing');
                panel.dataset.tv2Floating = 'true';
                panel.style.left = `${rect.left}px`;
                panel.style.top = `${rect.top}px`;
                panel.style.width = `${rect.width}px`;
                panel.style.height = `${rect.height}px`;
                activeResize = {
                    dir,
                    handle: grip,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                };
                try { grip.setPointerCapture(event.pointerId); } catch {}
                event.preventDefault();
                event.stopPropagation();
            };
            grip.addEventListener('pointerdown', start);
            grip.addEventListener('pointermove', resizeMove);
            grip.addEventListener('pointerup', resizeFinish);
            grip.addEventListener('pointercancel', resizeFinish);
            grip._tv2ResizeStart = start;
            panel.appendChild(grip);
            resizeHandles.push(grip);
        }
    }
    window.addEventListener('resize', clampCurrent);
    let resizeObserver = null;
    let resizeTimer = null;
    if (resizable && globalThis.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { clampCurrent(); savePlacement(); }, 120);
        });
        resizeObserver.observe(panel);
    }

    let disconnectObserver = null;
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        handle.removeEventListener('pointerdown', onDown);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        for (const grip of resizeHandles) {
            grip.removeEventListener('pointerdown', grip._tv2ResizeStart);
            grip.removeEventListener('pointermove', resizeMove);
            grip.removeEventListener('pointerup', resizeFinish);
            grip.removeEventListener('pointercancel', resizeFinish);
            grip.remove();
        }
        panel.classList.remove('tv2-custom-resize-window','tv2-window-resizing');
        window.removeEventListener('resize', clampCurrent);
        resizeObserver?.disconnect?.();
        disconnectObserver?.disconnect?.();
        clearTimeout(resizeTimer);
        handle.classList.remove('tv2-window-drag-handle');
        delete panel.dataset.tv2Draggable;
    };
    if (globalThis.MutationObserver && globalThis.document?.documentElement) {
        disconnectObserver = new MutationObserver(() => { if (!panel.isConnected) cleanup(); });
        disconnectObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    return cleanup;
}
