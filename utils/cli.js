const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const {
    ENABLE_CONSOLE_MENU,
    ENABLE_LEARNING,
    ENABLE_DISCUSSION,
    ENABLE_HOMEWORK,
    DISCUSSION_INTERVAL_MS,
    DISCUSSION_MAX_POSTS,
    DISCUSSION_SCAN_PAGES,
    DISCUSSION_MAX_ROUNDS,
    HOMEWORK_MAX_TASKS
} = require('./config');

function getDefaultRuntimeOptions() {
    return {
        enableLearning: ENABLE_LEARNING,
        enableDiscussion: ENABLE_DISCUSSION,
        enableHomework: ENABLE_HOMEWORK,
        enableTaskWorker: ENABLE_DISCUSSION || ENABLE_HOMEWORK,
        discussionIntervalMs: DISCUSSION_INTERVAL_MS,
        discussionMaxPosts: DISCUSSION_MAX_POSTS,
        discussionScanPages: DISCUSSION_SCAN_PAGES,
        discussionMaxRounds: DISCUSSION_MAX_ROUNDS,
        homeworkMaxTasks: HOMEWORK_MAX_TASKS
    };
}

async function askYesNo(rl, prompt, defaultValue) {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${prompt} (${suffix}): `)).trim();
    if (!answer) return defaultValue;
    return /^(y|yes|1|true|是)$/i.test(answer);
}

async function buildRuntimeOptions() {
    const defaults = getDefaultRuntimeOptions();
    if (!ENABLE_CONSOLE_MENU || !input.isTTY || !output.isTTY) {
        return defaults;
    }

    const rl = readline.createInterface({ input, output });
    try {
        const enableLearning = await askYesNo(rl, '是否自动学习视频/测验', defaults.enableLearning);
        const enableDiscussion = await askYesNo(rl, '是否自动评论', defaults.enableDiscussion);
        const enableHomework = await askYesNo(rl, '是否自动作业', defaults.enableHomework);

        return {
            ...defaults,
            enableLearning,
            enableDiscussion,
            enableHomework,
            enableTaskWorker: enableDiscussion || enableHomework
        };
    } finally {
        rl.close();
    }
}

module.exports = { buildRuntimeOptions };
