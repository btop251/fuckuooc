const path = require('path');
const { DATA_DIR } = require('./config');
const { locateInAnyFrame, humanClick, handleCaptcha } = require('./browser');
const { getAnswersFromImage, getTextAnswersFromImage } = require('./module');
const { safeTaskNavigate } = require('./task_page');

const HOMEWORK_INCOMPLETE_PROMPTS = [
    '还有题目没有做完',
    '题目没有做完'
];

const HOMEWORK_SUCCESS_PROMPTS = [
    '提交成功',
    '作业提交成功',
    '试卷提交成功'
];

const HOMEWORK_STATUS_VERIFY_RETRIES = 5;
const HOMEWORK_STATUS_VERIFY_INTERVAL_MS = 2000;

async function fetchJson(page, url, method = 'GET', body = null) {
    return page.evaluate(async ({ targetUrl, httpMethod, payload }) => {
        const options = {
            method: httpMethod,
            credentials: 'include',
            headers: {}
        };

        if (payload) {
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            options.body = new URLSearchParams(payload).toString();
        }

        const response = await fetch(targetUrl, options);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return { code: -1, msg: text };
        }
    }, {
        targetUrl: url,
        httpMethod: method,
        payload: body
    });
}

async function findHomeworkTasks(page, courseId) {
    const json = await fetchJson(page, `http://www.uooc.net.cn/home/task/homeworkList?cid=${courseId}&page=1&pagesize=100`);
    return Array.isArray(json?.data?.data) ? json.data.data : [];
}

function parseTaskTime(value) {
    if (!value) return Number.MAX_SAFE_INTEGER;
    const timestamp = Date.parse(String(value).replace(/-/g, '/'));
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function isPendingHomeworkTask(task) {
    if (!task) return false;
    const statusCode = Number(task.status_code ?? -1);
    const status = String(task.status || '');
    if (task.state && task.state.do === false) return false;
    return statusCode === 0 || status.includes('未提交');
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function isMeaningfulRichText(value) {
    return Boolean(
        String(value || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<\/p>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, '')
            .trim()
    );
}

async function dismissTaskPopups(page) {
    const selectors = [
        'button:has-text("暂时不要")',
        'button:has-text("取消")',
        'button:has-text("我知道了")'
    ];

    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
            await locator.click().catch(() => {});
            await page.waitForTimeout(300);
        }
    }
}

async function detectQuestionMeta(question) {
    return question.evaluate(element => {
        const typeText = (() => {
            let current = element.previousElementSibling;
            while (current) {
                if (current.classList.contains('queItems-type')) return (current.innerText || '').trim();
                current = current.previousElementSibling;
            }
            return '';
        })();

        const questionId = (() => {
            const index = element.querySelector('.index[id^="anchor"]');
            if (!index) return '';
            return String(index.id || '').replace(/^anchor/, '');
        })();

        const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
        const radioCount = element.querySelectorAll('input[type="radio"]').length;
        const checkboxCount = element.querySelectorAll('input[type="checkbox"]').length;
        const textInputs = Array.from(element.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea'))
            .map(node => ({
                id: node.id || '',
                name: node.name || '',
                tag: node.tagName,
                type: node.type || '',
                placeholder: node.placeholder || ''
            }));
        const ueContainers = Array.from(element.querySelectorAll('.ue-container, textarea.ue-container, script.ue-container, div[id^="u"], textarea[id^="u"]'))
            .map(node => ({
                id: node.id || '',
                tag: node.tagName,
                cls: node.className || ''
            }))
            .filter(node => node.id);

        let questionType = '未知题型';
        if (typeText.includes('填空')) questionType = '填空题';
        else if (typeText.includes('名词解释')) questionType = '名词解释';
        else if (typeText.includes('问答')) questionType = '问答题';
        else if (typeText.includes('论述')) questionType = '论述题';
        else if (typeText.includes('多选')) questionType = '多选题';
        else if (typeText.includes('判断')) questionType = '判断题';
        else if (typeText.includes('单选')) questionType = '单选题';
        else if (checkboxCount > 0) questionType = '多选题';
        else if (radioCount > 0) {
            const optionTexts = Array.from(element.querySelectorAll('.ti-a')).map(option => (option.innerText || '').replace(/\s+/g, ' ').trim());
            const isJudge = optionTexts.length === 2 &&
                optionTexts.some(option => option.includes('正确')) &&
                optionTexts.some(option => option.includes('错误'));
            questionType = isJudge ? '判断题' : '单选题';
        } else if (textInputs.length > 1 || ueContainers.length > 1) {
            questionType = '填空题';
        } else if (textInputs.length > 0 || ueContainers.length > 0) {
            questionType = '问答题';
        }

        return {
            questionId,
            typeText,
            text,
            questionType,
            radioCount,
            checkboxCount,
            textInputs,
            ueContainers
        };
    });
}

async function clickChoiceAnswers(question, answers, log) {
    for (const answer of answers) {
        const clean = String(answer || '').replace(/[.\s、]/g, '');
        let option = question.locator('.ti-a').filter({ hasText: `${clean}.` }).first();
        if (await option.count() === 0) {
            option = question.locator('.ti-a').filter({ hasText: clean }).first();
        }
        if (await option.count() > 0) {
            await option.click();
            log(`      选择 ${answer}`);
        } else {
            log(`      未找到选项 ${answer}`);
        }
    }
}

async function recognizeChoiceAnswers(question, page, screenshotPath, questionType, log) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        await question.screenshot({ path: screenshotPath });
        const answers = await getAnswersFromImage(screenshotPath, questionType, log);
        if (answers?.length > 0) return answers;
        log(`      客观题识别失败 (${attempt}/5)`);
        await page.waitForTimeout(1200);
    }
    return [];
}

async function recognizeTextAnswers(question, page, screenshotPath, questionType, answerCount, log) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        await question.screenshot({ path: screenshotPath });
        const answers = await getTextAnswersFromImage(screenshotPath, questionType, answerCount, log);
        if (answers?.length > 0) return answers;
        log(`      文本答案识别失败 (${attempt}/5)`);
        await page.waitForTimeout(1200);
    }
    return [];
}

async function fillQuestionTextAnswers(question, meta, answers, log) {
    const visibleTextInputs = question.locator('input[type="text"], input[type="search"], input:not([type]), textarea');
    const visibleCount = await visibleTextInputs.count();
    let filled = 0;

    for (let index = 0; index < visibleCount; index++) {
        const answer = answers[index] || answers[0];
        if (!answer) continue;
        await visibleTextInputs.nth(index).fill(answer);
        filled++;
        log(`      填写文本框 ${index + 1}: ${answer}`);
    }

    const ueIds = [...new Set(meta.ueContainers.map(item => item.id).filter(Boolean))];
    if (ueIds.length > 0) {
        await question.evaluate((element, payload) => {
            const doc = element.ownerDocument;
            const win = doc.defaultView;
            payload.ids.forEach((id, index) => {
                const value = payload.values[index] || payload.values[0] || '';
                const editor = win.UE && win.UE.getEditor ? win.UE.getEditor(id) : null;
                if (editor && typeof editor.ready === 'function') {
                    editor.ready(() => editor.setContent(value));
                }
                const plainNode = doc.getElementById(id);
                if (plainNode && 'value' in plainNode) {
                    plainNode.value = value;
                }
            });
        }, { ids: ueIds, values: answers });

        ueIds.forEach((id, index) => {
            const answer = answers[index] || answers[0] || '';
            if (!answer) return;
            filled++;
            log(`      填写编辑器 ${id}: ${answer}`);
        });
    }

    return filled > 0;
}

async function answerOneTaskQuestion(question, page, log, screenshotPath) {
    await question.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const meta = await detectQuestionMeta(question);
    log(`   题型: ${meta.questionType}`);

    if (['单选题', '多选题', '判断题'].includes(meta.questionType)) {
        const answers = await recognizeChoiceAnswers(question, page, screenshotPath, meta.questionType, log);
        if (answers.length === 0) {
            log('      未识别到客观题答案');
            return false;
        }
        await clickChoiceAnswers(question, answers, log);
        return true;
    }

    if (['填空题', '名词解释', '问答题', '论述题'].includes(meta.questionType)) {
        const answerCount = Math.max(1, meta.textInputs.length, meta.ueContainers.length);
        const answers = await recognizeTextAnswers(question, page, screenshotPath, meta.questionType, answerCount, log);
        if (answers.length === 0) {
            log('      未识别到文本答案');
            return false;
        }
        await fillQuestionTextAnswers(question, meta, answers, log);
        return true;
    }

    log(`      暂未支持题型: ${meta.questionType}`);
    return false;
}

async function collectHomeworkValidationState(page) {
    return page.evaluate(() => {
        function cleanText(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function isVisible(element) {
            if (!element) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
        }

        function meaningfulRichText(value) {
            return Boolean(
                String(value || '')
                    .replace(/<br\s*\/?>/gi, ' ')
                    .replace(/<\/p>/gi, ' ')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;/gi, ' ')
                    .replace(/\s+/g, '')
                    .trim()
            );
        }

        function getQuestionLabel(question, index) {
            const heading = question.querySelector('.index, .title, .que-title, .queTitle');
            const headingText = cleanText(heading?.innerText || '');
            if (headingText) return headingText;
            const text = cleanText(question.innerText || '');
            return `${index + 1}. ${text.slice(0, 40)}`;
        }

        function getEditorState(ids) {
            return ids.map(id => {
                const editor = window.UE && window.UE.getEditor ? window.UE.getEditor(id) : null;
                let content = '';
                if (editor && typeof editor.getContent === 'function') {
                    content = editor.getContent() || '';
                } else {
                    const node = document.getElementById(id);
                    if (node) content = node.value || node.innerHTML || '';
                }
                return {
                    id,
                    empty: !meaningfulRichText(content)
                };
            });
        }

        const questionStates = Array.from(document.querySelectorAll('.queContainer')).map((question, index) => {
            const typeText = (() => {
                let current = question.previousElementSibling;
                while (current) {
                    if (current.classList.contains('queItems-type')) return cleanText(current.innerText || '');
                    current = current.previousElementSibling;
                }
                return '';
            })();

            const label = getQuestionLabel(question, index);
            const choiceInputs = Array.from(question.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
            const checkedCount = choiceInputs.filter(input => input.checked).length;

            const textInputs = Array.from(question.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea'))
                .filter(node => {
                    const type = String(node.type || '').toLowerCase();
                    if (type === 'hidden') return false;
                    if (!isVisible(node)) return false;
                    if (node.classList.contains('ue-container')) return false;
                    if (node.id && /^u/i.test(node.id)) return false;
                    return true;
                });

            const emptyTextFields = textInputs
                .map((node, textIndex) => ({
                    field: textIndex + 1,
                    empty: !cleanText(node.value || '')
                }))
                .filter(item => item.empty);

            const editorIds = [...new Set(Array.from(question.querySelectorAll('.ue-container, textarea.ue-container, script.ue-container, div[id^="u"], textarea[id^="u"]'))
                .map(node => node.id)
                .filter(Boolean))];
            const emptyEditors = getEditorState(editorIds).filter(item => item.empty);

            const localErrors = Array.from(question.querySelectorAll('.help-block, .error, .warning, .form-error, .ivu-form-item-error-tip, .ant-form-item-explain-error, .el-form-item__error'))
                .map(node => cleanText(node.innerText || ''))
                .filter(Boolean);

            return {
                index: index + 1,
                label,
                typeText,
                choiceCount: choiceInputs.length,
                checkedCount,
                textFieldCount: textInputs.length,
                emptyTextFieldCount: emptyTextFields.length,
                emptyEditorCount: emptyEditors.length,
                localErrors
            };
        });

        const globalErrors = Array.from(document.querySelectorAll('.help-block, .error, .warning, .form-error, .ivu-form-item-error-tip, .ant-form-item-explain-error, .el-form-item__error'))
            .filter(isVisible)
            .map(node => cleanText(node.innerText || ''))
            .filter(Boolean);

        const promptTexts = Array.from(document.querySelectorAll('.layui-layer-title, .layui-layer-content, .layui-layer-btn, .ivu-modal-title, .ivu-modal-body, .ant-modal-title, .ant-modal-body, .el-message__content, .toast, .message, .msg'))
            .filter(isVisible)
            .map(node => cleanText(node.innerText || ''))
            .filter(Boolean);

        const submitElement = Array.from(document.querySelectorAll('button, div.btn, a.btn, input[type="button"], input[type="submit"]'))
            .find(node => isVisible(node) && cleanText(node.innerText || node.value).includes('提交'));

        const missingChoiceQuestions = questionStates
            .filter(state => state.choiceCount > 0 && state.checkedCount === 0)
            .map(state => ({ index: state.index, label: state.label }));

        const missingTextQuestions = questionStates
            .filter(state => (state.textFieldCount > 0 || state.emptyEditorCount >= 0) && (state.emptyTextFieldCount > 0 || state.emptyEditorCount > 0))
            .filter(state => state.textFieldCount > 0 || state.emptyEditorCount > 0)
            .map(state => ({ index: state.index, label: state.label }));

        return {
            questionCount: questionStates.length,
            missingChoiceQuestions,
            missingTextQuestions,
            questionStates,
            visibleErrors: [...new Set(globalErrors)],
            promptTexts: [...new Set(promptTexts)],
            submitButtonVisible: Boolean(submitElement),
            submitButtonDisabled: submitElement ? Boolean(submitElement.disabled || submitElement.classList.contains('disabled')) : true,
            canSubmit: Boolean(
                submitElement &&
                !submitElement.disabled &&
                !submitElement.classList.contains('disabled') &&
                missingChoiceQuestions.length === 0 &&
                missingTextQuestions.length === 0 &&
                globalErrors.length === 0
            )
        };
    });
}

function logHomeworkValidationState(log, state, phase = 'validation') {
    log(`[homework/${phase}] questionCount=${state.questionCount} missingChoice=${state.missingChoiceQuestions.length} missingText=${state.missingTextQuestions.length} visibleErrors=${state.visibleErrors.length}`);
    if (state.missingChoiceQuestions.length > 0) {
        log(`[homework/${phase}] missing choice: ${state.missingChoiceQuestions.map(item => item.label).join(' | ')}`);
    }
    if (state.missingTextQuestions.length > 0) {
        log(`[homework/${phase}] missing text: ${state.missingTextQuestions.map(item => item.label).join(' | ')}`);
    }
    if (state.visibleErrors.length > 0) {
        log(`[homework/${phase}] visible errors: ${state.visibleErrors.join(' | ')}`);
    }
}

async function findVisibleSubmitButton(page) {
    const selectors = [
        'button:has-text("提交试卷")',
        'button:has-text("提交作业")',
        'button.btn.btn-danger.ng-scope',
        'div.btn.btn-warning:has-text("提交")'
    ];

    for (const selector of selectors) {
        const button = page.locator(selector).first();
        if (await button.isVisible().catch(() => false)) {
            return button;
        }
    }

    return null;
}

async function readVisiblePromptTexts(page) {
    return page.evaluate(() => {
        function cleanText(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function isVisible(element) {
            if (!element) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
        }

        return Array.from(document.querySelectorAll('.layui-layer-title, .layui-layer-content, .layui-layer-btn, .ivu-modal-title, .ivu-modal-body, .ant-modal-title, .ant-modal-body, .el-message__content, .toast, .message, .msg'))
            .filter(isVisible)
            .map(node => cleanText(node.innerText || ''))
            .filter(Boolean);
    });
}

function hasIncompletePrompt(promptTexts) {
    return promptTexts.some(text => HOMEWORK_INCOMPLETE_PROMPTS.some(prompt => text.includes(prompt)));
}

function hasSuccessPrompt(promptTexts) {
    return promptTexts.some(text => HOMEWORK_SUCCESS_PROMPTS.some(prompt => text.includes(prompt)));
}

async function cancelSubmitPrompt(page, log) {
    const selectors = [
        'a.btn.btn-success:has-text("取消")',
        'button.btn.btn-success:has-text("取消")',
        '.layui-layer-btn1',
        'a:has-text("取消")',
        'button:has-text("取消")'
    ];

    for (const selector of selectors) {
        const button = page.locator(selector).first();
        if (!await button.isVisible().catch(() => false)) continue;
        await humanClick(page, button).catch(() => button.click({ force: true }));
        await page.waitForTimeout(500);
        log('[homework/submit] cancel incomplete submit prompt');
        return true;
    }

    return false;
}

async function waitForHomeworkStatusUpdate(page, courseId, taskId) {
    let lastTask = null;

    for (let attempt = 1; attempt <= HOMEWORK_STATUS_VERIFY_RETRIES; attempt++) {
        const tasks = await findHomeworkTasks(page, courseId).catch(() => []);
        const currentTask = tasks.find(task => Number(task.id || 0) === Number(taskId || 0));
        if (currentTask) lastTask = currentTask;
        if (currentTask && !isPendingHomeworkTask(currentTask)) {
            return { ok: true, task: currentTask, attempt };
        }
        if (attempt < HOMEWORK_STATUS_VERIFY_RETRIES) {
            await page.waitForTimeout(HOMEWORK_STATUS_VERIFY_INTERVAL_MS);
        }
    }

    return { ok: false, task: lastTask, attempt: HOMEWORK_STATUS_VERIFY_RETRIES };
}

async function answerTask(page, task, log) {
    await dismissTaskPopups(page);
    const questions = await page.locator('.queContainer').all();
    if (questions.length === 0) {
        log(`作业 [${task.name}] 没找到题目`);
        return false;
    }

    const screenshotPath = path.join(DATA_DIR, `homework_${task.id}.png`);
    log(`开始处理作业 [${task.name}]，共 ${questions.length} 题`);

    for (let index = 0; index < questions.length; index++) {
        const question = questions[index];
        log(`  题目 ${index + 1}/${questions.length}`);
        try {
            await answerOneTaskQuestion(question, page, log, screenshotPath);
        } catch (err) {
            log(`      题目处理失败: ${err.message}`);
        }
        await page.waitForTimeout(700);
    }

    const validationState = await collectHomeworkValidationState(page);
    logHomeworkValidationState(log, validationState, 'after-answer');
    return true;
}

async function submitTask(page, courseId, task, log) {
    await dismissTaskPopups(page);

    const agreementLabel = page.locator('label').filter({ hasText: '我确认已仔细阅读' }).first();
    if (await agreementLabel.count().catch(() => 0)) {
        const checkbox = agreementLabel.locator('input[type="checkbox"]').first();
        if (await checkbox.count().catch(() => 0)) {
            await checkbox.check({ force: true }).catch(() => {});
        }
    }

    const validationState = await collectHomeworkValidationState(page);
    logHomeworkValidationState(log, validationState, 'pre-submit');

    if (validationState.questionCount === 0) {
        log(`[homework/submit] ${task.name} has no question containers`);
        return false;
    }

    if (!validationState.submitButtonVisible || validationState.submitButtonDisabled) {
        log(`[homework/submit] ${task.name} submit button not ready`);
        return false;
    }

    if (!validationState.canSubmit) {
        log(`[homework/submit] ${task.name} blocked by validation before submit`);
        return false;
    }

    const submitButton = await findVisibleSubmitButton(page);
    if (!submitButton) {
        log(`[homework/submit] ${task.name} submit button not found`);
        return false;
    }

    await humanClick(page, submitButton).catch(() => submitButton.click({ force: true }));
    await page.waitForTimeout(1500);

    const initialPrompts = await readVisiblePromptTexts(page);
    if (hasIncompletePrompt(initialPrompts)) {
        log(`[homework/submit] ${task.name} prompt indicates incomplete homework`);
        await cancelSubmitPrompt(page, log);
        return false;
    }

    const locate = selector => locateInAnyFrame(page, selector);
    await handleCaptcha(page, locate, async () => {
        const confirm = await locate('div.btn.btn-warning:has-text("提交"), button.btn.btn-warning:has-text("提交"), .layui-layer-btn0');
        if (!confirm) return true;
        return !(await confirm.evaluate(element => element.disabled || element.classList.contains('disabled')).catch(() => false));
    }, 5, log).catch(() => {});

    const confirmSelectors = [
        'div.btn.btn-warning:has-text("提交")',
        'button.btn.btn-warning:has-text("提交")',
        '.layui-layer-btn0'
    ];

    for (const selector of confirmSelectors) {
        const confirm = await locate(selector);
        if (!confirm) continue;
        await humanClick(page, confirm).catch(() => confirm.click({ force: true }));
        await page.waitForTimeout(1200);
        break;
    }

    const afterConfirmPrompts = await readVisiblePromptTexts(page);
    if (hasIncompletePrompt(afterConfirmPrompts)) {
        log(`[homework/submit] ${task.name} prompt indicates incomplete homework after confirm`);
        await cancelSubmitPrompt(page, log);
        return false;
    }

    if (hasSuccessPrompt(afterConfirmPrompts)) {
        log(`[homework/submit] ${task.name} success prompt detected`);
    }

    const verifyResult = await waitForHomeworkStatusUpdate(page, courseId, task.id);
    if (!verifyResult.ok) {
        const statusText = verifyResult.task ? `${verifyResult.task.status || 'unknown'} / ${verifyResult.task.status_code ?? 'unknown'}` : 'not found';
        log(`[homework/submit] ${task.name} submission not verified, last status=${statusText}`);
        return false;
    }

    log(`[homework/submit] ${task.name} submission verified after ${verifyResult.attempt} checks`);
    return true;
}

async function runCourseHomeworkAutomation(page, courseId, log, options = {}) {
    try {
        await safeTaskNavigate(page, `http://www.uooc.net.cn/home/course/${courseId}#/homework`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
            settleMs: 3000
        });
    } catch (err) {
        log(`打开作业页失败: ${err.message}`);
        return 0;
    }

    const tasks = (await findHomeworkTasks(page, courseId))
        .filter(isPendingHomeworkTask)
        .sort((left, right) => {
            const endDiff = parseTaskTime(left.end_time) - parseTaskTime(right.end_time);
            if (endDiff !== 0) return endDiff;
            const startDiff = parseTaskTime(left.start_time) - parseTaskTime(right.start_time);
            if (startDiff !== 0) return startDiff;
            return Number(left.id || 0) - Number(right.id || 0);
        });

    if (tasks.length === 0) {
        log('当前课程没有可自动处理的作业');
        return 0;
    }

    const maxTasks = options.homeworkMaxTasks > 0 ? options.homeworkMaxTasks : tasks.length;
    log(`作业执行顺序（最早截止优先）: ${tasks.slice(0, maxTasks).map(task => `${task.name} @ ${task.end_time || 'unknown'}`).join(' | ')}`);

    let handledCount = 0;
    for (const task of tasks.slice(0, maxTasks)) {
        try {
            log(`打开作业 [${task.name}]`);
            await safeTaskNavigate(page, `http://www.uooc.net.cn/exam/${task.id}`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
                settleMs: 4000
            });

            const answered = await answerTask(page, task, log);
            if (!answered) continue;

            const submitted = await submitTask(page, courseId, task, log);
            if (submitted) {
                handledCount++;
            }
        } catch (err) {
            log(`作业 [${task.name}] 处理失败: ${err.message}`);
        }
    }

    return handledCount;
}

module.exports = { runCourseHomeworkAutomation, findHomeworkTasks, fetchJson };
