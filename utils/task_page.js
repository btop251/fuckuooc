class TaskPageClosedError extends Error {
    constructor(message = 'Task page was closed') {
        super(message);
        this.name = 'TaskPageClosedError';
        this.code = 'TASK_PAGE_CLOSED';
    }
}

function isPageUsable(page) {
    return Boolean(page && !page.isClosed());
}

function isRecoverableTaskPageError(page, err) {
    if (err instanceof TaskPageClosedError) return true;
    if (page && page.isClosed()) return true;

    const message = String(err?.message || err || '').toLowerCase();
    return (
        message.includes('target closed') ||
        message.includes('page closed') ||
        message.includes('page has been closed') ||
        message.includes('target page, context or browser has been closed') ||
        (message.includes('was not bound in the connection') && message.includes('response@'))
    );
}

async function createTaskPage(context) {
    const page = await context.newPage();
    await page.bringToFront().catch(() => {});
    return page;
}

async function ensureTaskPage(context, page) {
    if (isPageUsable(page)) return page;
    return createTaskPage(context);
}

function createCloseSignal(page) {
    if (!page) return { promise: Promise.resolve({ closed: true }), dispose() {} };
    if (page.isClosed()) return { promise: Promise.resolve({ closed: true }), dispose() {} };

    let listener = null;
    const promise = new Promise(resolve => {
        listener = () => resolve({ closed: true });
        page.once('close', listener);
    });

    return {
        promise,
        dispose() {
            if (listener) {
                page.off('close', listener);
                listener = null;
            }
        }
    };
}

async function safeTaskNavigate(page, url, options = {}) {
    const waitUntil = options.waitUntil || 'domcontentloaded';
    const timeout = options.timeout || 60000;
    const settleMs = options.settleMs ?? 0;
    const expectedUrl = String(url);

    if (!isPageUsable(page)) {
        throw new TaskPageClosedError();
    }

    const closeSignal = createCloseSignal(page);

    try {
        await page.evaluate(targetUrl => {
            if (location.href !== targetUrl) {
                location.assign(targetUrl);
            }
        }, expectedUrl);

        const navigationPromise = (async () => {
            await page.waitForURL(currentUrl => String(currentUrl) === expectedUrl, { timeout });
            if (waitUntil && waitUntil !== 'commit') {
                await page.waitForLoadState(waitUntil, { timeout }).catch(() => {});
            }
            if (settleMs > 0) {
                await page.waitForTimeout(settleMs);
            }
            return { closed: false };
        })();

        const result = await Promise.race([navigationPromise, closeSignal.promise]);
        if (result?.closed) {
            throw new TaskPageClosedError();
        }
    } catch (err) {
        if (isRecoverableTaskPageError(page, err)) {
            throw new TaskPageClosedError(err.message);
        }
        throw err;
    } finally {
        closeSignal.dispose();
    }
}

module.exports = {
    TaskPageClosedError,
    isPageUsable,
    isRecoverableTaskPageError,
    createTaskPage,
    ensureTaskPage,
    safeTaskNavigate
};
