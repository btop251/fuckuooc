const { runCourseDiscussionAutomation } = require('./discussion');
const { runCourseHomeworkAutomation, fetchJson } = require('./task');
const {
    isPageUsable,
    isRecoverableTaskPageError,
    createTaskPage,
    ensureTaskPage,
    safeTaskNavigate
} = require('./task_page');

async function getCourseProgress(page, courseId) {
    await safeTaskNavigate(page, `http://www.uooc.net.cn/home/course/${courseId}#/result`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
        settleMs: 2500
    });
    return fetchJson(page, `http://www.uooc.net.cn/home/course/progress?cid=${courseId}`);
}

function parseNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getDiscussionSnapshot(progress) {
    const data = progress?.data || progress || {};
    return {
        weight: parseNumber(data.discuz, 0),
        score: parseNumber(data.discuss_score, 0),
        avgScore: parseNumber(data.discuss_avg_score, 0),
        count: parseNumber(data.discuss_cnt ?? (parseNumber(data.discuss_publish_cnt, 0) + parseNumber(data.discuss_reply_cnt, 0)), 0),
        publishCount: parseNumber(data.discuss_publish_cnt, 0),
        replyCount: parseNumber(data.discuss_reply_cnt, 0)
    };
}

function getHomeworkSnapshot(progress) {
    const data = progress?.data || progress || {};
    return {
        done: parseNumber(data.homework_cnt, 0),
        total: parseNumber(data.homework_total, 0),
        avgScore: parseNumber(data.homework_avg_score, 0),
        weightedScore: parseNumber(data.homework_score, 0)
    };
}

function discussionNeedMore(snapshot) {
    if (snapshot.weight <= 0) return false;
    return snapshot.score + 0.001 < snapshot.weight;
}

function createTaskLogger(options, index, total, courseId) {
    return options.createLogger
        ? options.createLogger(`[任务窗${index + 1}/${total}:${courseId}]`, index)
        : console.log;
}

function markPageClosedSkip(log, courseId, phase) {
    log(`[task-worker] task page closed during ${phase}, skip ${courseId} and continue next course`);
}

async function refreshCourseProgress(page, courseId, progress, log) {
    try {
        const nextProgress = await getCourseProgress(page, courseId);
        await page.bringToFront().catch(() => {});
        return nextProgress;
    } catch (err) {
        if (isRecoverableTaskPageError(page, err)) {
            markPageClosedSkip(log, courseId, 'progress refresh');
            return null;
        }
        log(`[task-worker] refresh progress for ${courseId} failed: ${err.message}`);
        return progress;
    }
}

async function runCourseTaskWorker(context, courseIds, options = {}) {
    let page = await createTaskPage(context);

    try {
        for (let index = 0; index < courseIds.length; index++) {
            const courseId = courseIds[index];
            const log = createTaskLogger(options, index, courseIds.length, courseId);

            try {
                page = await ensureTaskPage(context, page);
            } catch (err) {
                log(`[task-worker] create task page failed: ${err.message}`);
                break;
            }

            log('[task-worker] start course task workflow');

            let progress;
            try {
                progress = await getCourseProgress(page, courseId);
                await page.bringToFront().catch(() => {});
            } catch (err) {
                if (isRecoverableTaskPageError(page, err)) {
                    markPageClosedSkip(log, courseId, 'progress fetch');
                    page = null;
                    continue;
                }
                log(`[task-worker] get progress for ${courseId} failed: ${err.message}`);
                continue;
            }

            let homework = getHomeworkSnapshot(progress);
            let discussion = getDiscussionSnapshot(progress);
            log(`[task-worker] homework ${homework.done}/${homework.total}, discussion ${discussion.score}/${discussion.weight}, count ${discussion.count}`);

            if (options.enableHomework) {
                const handled = await runCourseHomeworkAutomation(page, courseId, log, options).catch(err => {
                    log(`[task-worker] homework workflow failed: ${err.message}`);
                    return 0;
                });

                if (!isPageUsable(page)) {
                    markPageClosedSkip(log, courseId, 'homework workflow');
                    page = null;
                    continue;
                }

                if (handled > 0) {
                    const nextProgress = await refreshCourseProgress(page, courseId, progress, log);
                    if (nextProgress === null) {
                        page = null;
                        continue;
                    }
                    progress = nextProgress;
                    homework = getHomeworkSnapshot(progress);
                    discussion = getDiscussionSnapshot(progress);
                    log(`[task-worker] homework after workflow: ${homework.done}/${homework.total}`);
                }
            }

            if (options.enableDiscussion) {
                let rounds = 0;
                let skipCurrentCourse = false;

                while (discussionNeedMore(discussion)) {
                    if (!isPageUsable(page)) {
                        markPageClosedSkip(log, courseId, 'discussion before round');
                        page = null;
                        skipCurrentCourse = true;
                        break;
                    }

                    rounds++;
                    log(`[task-worker] discussion round ${rounds}, current ${discussion.score}/${discussion.weight}, count ${discussion.count}`);

                    const sent = await runCourseDiscussionAutomation(page, courseId, log, options).catch(err => {
                        log(`[task-worker] discussion workflow failed: ${err.message}`);
                        return 0;
                    });

                    if (!isPageUsable(page)) {
                        markPageClosedSkip(log, courseId, 'discussion workflow');
                        page = null;
                        skipCurrentCourse = true;
                        break;
                    }

                    if (sent <= 0) {
                        log('[task-worker] no new discussion targets, finish current course discussion');
                        break;
                    }

                    const nextProgress = await refreshCourseProgress(page, courseId, progress, log);
                    if (nextProgress === null) {
                        page = null;
                        skipCurrentCourse = true;
                        break;
                    }

                    progress = nextProgress;
                    discussion = getDiscussionSnapshot(progress);
                    log(`[task-worker] discussion after round: ${discussion.score}/${discussion.weight}, count ${discussion.count}`);

                    if (rounds >= (options.discussionMaxRounds || 5)) {
                        log('[task-worker] discussion rounds reached limit, move to next course');
                        break;
                    }
                }

                if (skipCurrentCourse) {
                    continue;
                }
            }

            log('[task-worker] current course task workflow completed');
        }
    } finally {
        if (isPageUsable(page)) {
            await page.close().catch(() => {});
        }
    }
}

module.exports = { runCourseTaskWorker, getCourseProgress, getDiscussionSnapshot, getHomeworkSnapshot };
