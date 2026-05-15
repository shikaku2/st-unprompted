import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { Generate, deleteMessage, saveSettingsDebounced, substituteParams, getRequestHeaders, characters, getPastCharacterChats } from '../../../../script.js';

const EXT_NAME = 'unprompted';
const DISPLAY_NAME = 'Unprompted Messages';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SAY_NOTHING_RE = /\[saynothing\]/i;
const TRY_LATER_RE = /\[trylater\]/i;
const SAY_NOTHING_INSTRUCTION = 'Continue the conversation naturally, but if it is not natural to say anything, or {{user}} says they will message later or asks you to wait for them to message first, output only [saynothing].';

const DEFAULT_PROMPTS = [
    {
        id: crypto.randomUUID(),
        enabled: true,
        weight: 5,
        label: 'Last thing discussed',
        prompt: 'Send an unprompted message commenting naturally about the last thing you and {{user}} talked about. If it is not natural to say anything, or {{user}} has asked you to wait for them to message first, output only [saynothing]. Context:\n[lastmessages=1]',
    },
    {
        id: crypto.randomUUID(),
        enabled: true,
        weight: 5,
        label: 'Past day topic',
        prompt: 'Send an unprompted message about an important-looking topic from the past day that you might want an update on. If it is not natural to say anything, or {{user}} has asked you to wait for them to message first, output only [saynothing]. Context:\n[1d]',
    },
    {
        id: crypto.randomUUID(),
        enabled: true,
        weight: 3,
        label: 'Past week topic',
        prompt: 'Send an unprompted message about an important-looking topic from the past week that you might want an update on. If it is not natural to say anything, or {{user}} has asked you to wait for them to message first, output only [saynothing]. Context:\n[7d]',
    },
    {
        id: crypto.randomUUID(),
        enabled: true,
        weight: 2,
        label: 'Past month topic',
        prompt: 'Send an unprompted message about an important-looking topic from the past month that you might want an update on. If it is not natural to say anything, or {{user}} has asked you to wait for them to message first, output only [saynothing]. Context:\n[1m]',
    },
    {
        id: crypto.randomUUID(),
        enabled: true,
        weight: 5,
        label: 'What they are doing',
        prompt: 'Send an unprompted message about something you are doing right now. Keep it in-character and natural. If it is not natural to say anything, or {{user}} has asked you to wait for them to message first, output only [saynothing].',
    },
];

const DEFAULT_SETTINGS = {
    enabled: false,
    checkMinutes: 30,
    cooldownMinutes: 180,
    maxAiInRow: 2,
    runOnChatOpen: false,
    resetTimerOnUserMessage: false,
    browserNotifications: false,
    prompts: DEFAULT_PROMPTS,
    stateByChat: {},
};

let checkTimer = null;
let timerStartedAt = 0;
let timerDisplayTick = null;
let unpromptedInFlight = false;
let pendingNotification = null;
let tryLaterDetected = false;

function getSettings() {
    return extension_settings[EXT_NAME];
}

function loadSettings() {
    const existing = extension_settings[EXT_NAME] || {};
    const merged = Object.assign(structuredClone(DEFAULT_SETTINGS), existing);
    merged.cooldownMinutes = normalizeCooldownMinutes(existing);
    delete merged.cooldownHours;
    merged.prompts = Array.isArray(existing.prompts) && existing.prompts.length
        ? existing.prompts.map(normalizePrompt)
        : structuredClone(DEFAULT_PROMPTS);
    merged.stateByChat = existing.stateByChat && typeof existing.stateByChat === 'object'
        ? existing.stateByChat
        : {};
    extension_settings[EXT_NAME] = merged;
}

function normalizeCooldownMinutes(settings) {
    if (settings && Object.prototype.hasOwnProperty.call(settings, 'cooldownMinutes')) {
        return positiveNumber(settings.cooldownMinutes, DEFAULT_SETTINGS.cooldownMinutes);
    }
    if (settings && Object.prototype.hasOwnProperty.call(settings, 'cooldownHours')) {
        return positiveNumber(settings.cooldownHours, DEFAULT_SETTINGS.cooldownMinutes / 60) * 60;
    }
    return DEFAULT_SETTINGS.cooldownMinutes;
}

function normalizePrompt(prompt) {
    return {
        id: prompt.id || crypto.randomUUID(),
        enabled: prompt.enabled !== false,
        weight: positiveNumber(prompt.weight, 1),
        label: String(prompt.label || 'Unprompted prompt'),
        prompt: String(prompt.prompt || ''),
    };
}

function positiveNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function clampInteger(value, min, fallback) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) && num >= min ? num : fallback;
}

function getChatKey(ctx = getContext()) {
    if (ctx.groupId) return `group:${ctx.groupId}`;
    if (ctx.characterId !== undefined && ctx.chatId) return `char:${ctx.characterId}:${ctx.chatId}`;
    return '';
}

function getChatState(chatKey) {
    const s = getSettings();
    if (!s.stateByChat[chatKey]) {
        s.stateByChat[chatKey] = { lastSentAt: 0, lastCheckedAt: 0, silentUntilUserMessage: false };
    }
    return s.stateByChat[chatKey];
}

function countTrailingAiMessages(chat) {
    let count = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        if (msg.is_user) break;
        count++;
    }
    return count;
}

function parseMessageTime(message) {
    const raw = message?.send_date;
    if (!raw) return 0;
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function cleanMessageText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function previewText(text, limit = 100) {
    const cleaned = cleanMessageText(text);
    return cleaned.length > limit ? `${cleaned.slice(0, limit - 3)}...` : cleaned;
}

function formatMessage(message) {
    const name = message.name || (message.is_user ? 'User' : 'Assistant');
    const text = cleanMessageText(message.mes);
    return text ? `${name}: ${text}` : '';
}

function getRecentMessagesByCount(chat, count) {
    const usable = chat.filter(msg => msg && !msg.is_system && cleanMessageText(msg.mes));
    return usable.slice(Math.max(0, usable.length - count));
}

function getRecentMessagesByExchangeCount(chat, count) {
    const messages = chat
        .map((msg, index) => ({ msg, index }))
        .filter(({ msg }) => msg && !msg.is_system && cleanMessageText(msg.mes));

    if (!messages.length) return [];

    let startIndex = messages[0].msg.is_user ? messages[0].index : -1;
    let exchangesFound = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const { msg, index } = messages[i];

        if (msg.is_user) {
            exchangesFound++;
            startIndex = index;
            if (exchangesFound >= count) break;
        }
    }

    if (startIndex < 0 || exchangesFound < count) {
        startIndex = messages[0].index;
    }

    return chat.slice(startIndex).filter(msg => msg && !msg.is_system && cleanMessageText(msg.mes));
}

function getRecentMessagesByAge(chat, ageMs) {
    const cutoff = Date.now() - ageMs;
    return chat.filter(msg => {
        if (!msg || msg.is_system || !cleanMessageText(msg.mes)) return false;
        const time = parseMessageTime(msg);
        return time && time >= cutoff;
    });
}

const otherChatMessagesCache = { key: '', ageMs: 0, fetchedAt: 0, messages: [] };
const OTHER_CHAT_CACHE_TTL_MS = 60 * 1000;

function parseChatLastMes(meta) {
    if (!meta) return 0;
    const raw = meta.last_mes;
    if (!raw) return 0;
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchChatMessages(fileName) {
    const ctx = getContext();
    const characterId = ctx.characterId;
    if (characterId === undefined || !characters?.[characterId]) return [];
    try {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                ch_name: characters[characterId].name,
                file_name: String(fileName).replace(/\.jsonl$/, ''),
                avatar_url: characters[characterId].avatar,
            }),
        });
        if (!response.ok) return [];
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) return [];
        // First element is chat metadata; the rest are messages.
        return data.slice(1);
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to load chat file ${fileName}`, err);
        return [];
    }
}

async function getOtherChatsMessagesSince(cutoff) {
    const ctx = getContext();
    // Multi-chat gathering is only supported for single-character chats (not groups).
    if (ctx.groupId || ctx.characterId === undefined) return [];

    const cacheKey = `char:${ctx.characterId}`;
    const now = Date.now();
    const ageMs = now - cutoff;
    if (otherChatMessagesCache.key === cacheKey
        && otherChatMessagesCache.ageMs >= ageMs
        && now - otherChatMessagesCache.fetchedAt < OTHER_CHAT_CACHE_TTL_MS) {
        return otherChatMessagesCache.messages.filter(m => parseMessageTime(m) >= cutoff);
    }

    let pastChats = [];
    try {
        pastChats = await getPastCharacterChats(ctx.characterId);
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to list past chats`, err);
        return [];
    }
    if (!Array.isArray(pastChats) || !pastChats.length) return [];

    const currentChatFile = ctx.chatId ? String(ctx.chatId).replace(/\.jsonl$/, '') : '';
    const candidates = pastChats.filter(meta => {
        const fileName = String(meta?.file_name || '').replace(/\.jsonl$/, '');
        if (!fileName || fileName === currentChatFile) return false;
        const lastMes = parseChatLastMes(meta);
        return lastMes && lastMes >= cutoff;
    });

    const loaded = await Promise.all(candidates.map(meta => fetchChatMessages(meta.file_name)));
    const merged = loaded.flat().filter(msg => {
        if (!msg || msg.is_system || !cleanMessageText(msg.mes)) return false;
        const time = parseMessageTime(msg);
        return time && time >= cutoff;
    });

    otherChatMessagesCache.key = cacheKey;
    otherChatMessagesCache.ageMs = ageMs;
    otherChatMessagesCache.fetchedAt = now;
    otherChatMessagesCache.messages = merged;

    return merged;
}

async function getAllRecentMessagesByAge(chat, ageMs) {
    const cutoff = Date.now() - ageMs;
    const current = getRecentMessagesByAge(chat, ageMs);
    const others = await getOtherChatsMessagesSince(cutoff);
    if (!others.length) return current;
    const combined = others.concat(current);
    combined.sort((a, b) => parseMessageTime(a) - parseMessageTime(b));
    return combined;
}

function durationToMs(raw) {
    const compact = String(raw || '').trim().toLowerCase();
    if (!compact) return 0;

    let total = 0;
    const re = /(\d+(?:\.\d+)?)(m|d|h|w)/g;
    let match;
    while ((match = re.exec(compact)) !== null) {
        const amount = Number(match[1]);
        const unit = match[2];
        if (unit === 'm') total += amount * MONTH_MS;
        if (unit === 'w') total += amount * WEEK_MS;
        if (unit === 'd') total += amount * DAY_MS;
        if (unit === 'h') total += amount * HOUR_MS;
    }
    return total;
}

async function replaceAsync(input, regex, replacer) {
    const matches = [];
    input.replace(regex, (...args) => {
        matches.push(args);
        return '';
    });
    const replacements = await Promise.all(matches.map(args => Promise.resolve(replacer(...args))));
    let i = 0;
    return input.replace(regex, () => replacements[i++]);
}

async function expandCustomMacros(prompt) {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];

    let expanded = String(prompt || '');

    expanded = await replaceAsync(expanded, /\[lastmessages=([^\]]+)\]/gi, async (_match, raw) => {
        const trimmed = raw.trim();
        if (/^\d+$/.test(trimmed)) {
            const messages = getRecentMessagesByCount(chat, clampInteger(trimmed, 1, 1));
            return messages.map(formatMessage).filter(Boolean).join('\n') || '(no recent messages)';
        }
        const ms = durationToMs(trimmed);
        if (ms > 0) {
            const messages = await getAllRecentMessagesByAge(chat, ms);
            return messages.map(formatMessage).filter(Boolean).join('\n') || `(no messages in the last ${trimmed})`;
        }
        return '(no recent messages)';
    });

    expanded = await replaceAsync(expanded, /\[lastexchanges=([^\]]+)\]/gi, async (_match, raw) => {
        const trimmed = raw.trim();
        if (/^\d+$/.test(trimmed)) {
            const messages = getRecentMessagesByExchangeCount(chat, clampInteger(trimmed, 1, 1));
            return messages.map(formatMessage).filter(Boolean).join('\n') || '(no recent exchanges)';
        }
        const ms = durationToMs(trimmed);
        if (ms > 0) {
            const messages = await getAllRecentMessagesByAge(chat, ms);
            return messages.map(formatMessage).filter(Boolean).join('\n') || `(no messages in the last ${trimmed})`;
        }
        return '(no recent exchanges)';
    });

    expanded = await replaceAsync(expanded, /\[((?:\d+(?:\.\d+)?[mdhw])+)\]/gi, async (_match, durationRaw) => {
        const messages = await getAllRecentMessagesByAge(chat, durationToMs(durationRaw));
        return messages.map(formatMessage).filter(Boolean).join('\n') || `(no messages in the last ${durationRaw})`;
    });

    try {
        expanded = substituteParams(expanded);
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to substitute SillyTavern macros`, err);
    }

    return expanded.trim();
}

async function addSayNothingInstruction(prompt) {
    const trimmed = String(prompt || '').trim();
    if (!trimmed || SAY_NOTHING_RE.test(trimmed) || TRY_LATER_RE.test(trimmed)) return trimmed;
    const appendix = await expandCustomMacros(SAY_NOTHING_INSTRUCTION);
    return `${trimmed}\n\n${appendix}`;
}

function pickPrompt() {
    const prompts = getSettings().prompts
        .map(normalizePrompt)
        .filter(prompt => prompt.enabled && prompt.weight > 0 && prompt.prompt.trim());

    const total = prompts.reduce((sum, prompt) => sum + prompt.weight, 0);
    if (!prompts.length || total <= 0) return null;

    let roll = Math.random() * total;
    for (const prompt of prompts) {
        roll -= prompt.weight;
        if (roll < 0) return prompt;
    }
    return prompts[prompts.length - 1];
}

function hasUserDraft() {
    const textarea = document.getElementById('send_textarea');
    return typeof textarea?.value === 'string' && textarea.value.length > 0;
}

function canSendNow({ manual = false } = {}) {
    const s = getSettings();
    if (unpromptedInFlight) return { ok: false, reason: 'unprompted generation already running' };
    if (!manual && !s.enabled) return { ok: false, reason: 'disabled' };
    if (hasUserDraft()) return { ok: false, reason: 'user draft in compose box' };

    const ctx = getContext();
    if ((!ctx.chatId && !ctx.groupId) || !Array.isArray(ctx.chat) || !ctx.chat.length) {
        return { ok: false, reason: 'no active chat' };
    }

    const trailingAi = countTrailingAiMessages(ctx.chat);
    if (trailingAi >= clampInteger(s.maxAiInRow, 1, DEFAULT_SETTINGS.maxAiInRow)) {
        return { ok: false, reason: `already has ${trailingAi} AI messages in a row` };
    }

    const chatKey = getChatKey(ctx);
    if (!chatKey) return { ok: false, reason: 'no chat key' };

    const state = getChatState(chatKey);
    if (state.silentUntilUserMessage) {
        return { ok: false, reason: 'waiting for user message after [saynothing]' };
    }

    const cooldownMs = positiveNumber(s.cooldownMinutes, DEFAULT_SETTINGS.cooldownMinutes) * MINUTE_MS;
    if (!manual && state.lastSentAt && Date.now() - state.lastSentAt < cooldownMs) {
        return { ok: false, reason: 'cooldown' };
    }

    return { ok: true, chatKey, state };
}

async function trySendUnprompted(manual = false) {
    const allowed = canSendNow({ manual });
    updateStatus(allowed.ok ? 'Rolling prompt...' : `Idle: ${allowed.reason}`);
    if (!allowed.ok) {
        if (manual) toastr.info(allowed.reason, DISPLAY_NAME);
        return false;
    }

    const selected = pickPrompt();
    if (!selected) {
        updateStatus('No enabled prompts.');
        if (manual) toastr.warning('No enabled prompts.', DISPLAY_NAME);
        return false;
    }

    const quietPrompt = await addSayNothingInstruction(await expandCustomMacros(selected.prompt));
    if (!quietPrompt) {
        updateStatus('Selected prompt expanded to empty text.');
        if (manual) toastr.warning('Selected prompt expanded to empty text.', DISPLAY_NAME);
        return false;
    }

    allowed.state.lastCheckedAt = Date.now();
    saveSettingsDebounced();
    updateStatus(`Sending: ${selected.label}`);

    unpromptedInFlight = true;
    tryLaterDetected = false;
    try {
        pendingNotification = {
            chatKey: allowed.chatKey,
            startedAt: Date.now(),
        };
        await Generate('normal', {
            automatic_trigger: true,
            quiet_prompt: quietPrompt,
            quietToLoud: true,
        });
        if (allowed.state.silentUntilUserMessage) {
            updateStatus('Paused by [saynothing] until user replies.');
            return false;
        }
        if (tryLaterDetected) {
            updateStatus('Idle: will try again next check.');
            return false;
        }
        allowed.state.lastSentAt = Date.now();
        saveSettingsDebounced();
        updateStatus(`Last sent: ${selected.label}`);
        return true;
    } catch (err) {
        pendingNotification = null;
        console.error(`[${EXT_NAME}] Failed to generate unprompted message`, err);
        updateStatus('Generation failed. Check console.');
        if (manual) toastr.error('Generation failed. Check console.', DISPLAY_NAME);
        return false;
    } finally {
        unpromptedInFlight = false;
    }
}

function updateTimerDisplay() {
    const el = document.getElementById('unprompted_timer_display');
    if (!el) return;
    const s = getSettings();
    if (!s.enabled) {
        el.textContent = '(disabled)';
        return;
    }
    if (!checkTimer || !timerStartedAt) {
        el.textContent = '';
        return;
    }
    const intervalMs = positiveNumber(s.checkMinutes, DEFAULT_SETTINGS.checkMinutes) * MINUTE_MS;
    const remaining = Math.max(0, intervalMs - (Date.now() - timerStartedAt));
    const remainingMin = Math.ceil(remaining / MINUTE_MS);
    el.textContent = remainingMin <= 1 ? '(<1min)' : `(${remainingMin}min)`;
}

function startTimer() {
    stopTimer();
    const s = getSettings();
    if (!s.enabled) return;

    timerStartedAt = Date.now();
    const intervalMs = positiveNumber(s.checkMinutes, DEFAULT_SETTINGS.checkMinutes) * MINUTE_MS;
    checkTimer = setInterval(() => {
        timerStartedAt = Date.now();
        updateTimerDisplay();
        trySendUnprompted(false);
    }, intervalMs);
    timerDisplayTick = setInterval(updateTimerDisplay, MINUTE_MS);
    updateTimerDisplay();
    updateStatus(`Checking every ${s.checkMinutes} min.`);
}

function stopTimer() {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
    if (timerDisplayTick) {
        clearInterval(timerDisplayTick);
        timerDisplayTick = null;
    }
    timerStartedAt = 0;
    updateTimerDisplay();
}

function restartTimer() {
    if (getSettings().enabled) startTimer();
    else stopTimer();
}

function escHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function updateStatus(text) {
    const el = document.getElementById('unprompted_status');
    if (el) el.textContent = text || '';
}

function canUseBrowserNotifications() {
    return 'Notification' in window;
}

function getNotificationUnavailableReason() {
    if (!canUseBrowserNotifications()) return 'Browser notifications are not supported.';
    if (Notification.permission === 'denied') return 'Browser notifications are blocked for this site.';
    return '';
}

function syncNotificationUI() {
    const checkbox = document.getElementById('unprompted_browser_notifications');
    const note = document.getElementById('unprompted_notification_note');
    if (!checkbox) return;

    const s = getSettings();
    const unavailableReason = getNotificationUnavailableReason();
    const canEnable = !unavailableReason;

    if (!canEnable) {
        checkbox.checked = false;
        checkbox.disabled = true;
        if (note) note.textContent = unavailableReason;
        return;
    }

    checkbox.disabled = false;
    checkbox.checked = !!s.browserNotifications && Notification.permission === 'granted';
    if (note) {
        note.textContent = Notification.permission === 'granted'
            ? 'Browser notifications are enabled for this site.'
            : 'Checking this will ask the browser for notification permission.';
    }
}

async function requestBrowserNotificationSetting(enable) {
    const s = getSettings();
    if (!enable) {
        s.browserNotifications = false;
        saveSettingsDebounced();
        syncNotificationUI();
        return;
    }

    if (!canUseBrowserNotifications()) {
        syncNotificationUI();
        return;
    }

    let permission = Notification.permission;
    if (permission === 'default') {
        permission = await Notification.requestPermission();
    }

    if (permission === 'granted') {
        s.browserNotifications = true;
        saveSettingsDebounced();
    }
    syncNotificationUI();
}

function showBrowserNotification(message) {
    const s = getSettings();
    if (!s.browserNotifications || !canUseBrowserNotifications() || Notification.permission !== 'granted') {
        syncNotificationUI();
        return;
    }

    const name = message?.name || 'AI';
    const preview = previewText(message?.mes || '');
    if (!preview) return;

    const notification = new Notification(`${name}: ${preview}`, {
        tag: `${EXT_NAME}-${Date.now()}`,
        silent: false,
    });
    notification.onclick = () => {
        window.focus();
        notification.close();
    };
}

async function robustDeleteMessage(messageId, label) {
    const id = Number(messageId);
    const ctx = getContext();
    const targetMessage = ctx.chat?.[id];

    // Yield to let any pending streaming/DOM finalization microtasks settle.
    await new Promise(resolve => setTimeout(resolve, 0));

    let deleted = false;
    try {
        await deleteMessage(id, undefined, false);
        deleted = true;
    } catch (err) {
        console.error(`[${EXT_NAME}] deleteMessage threw for ${label}`, err);
    }

    // Verify deletion. ST's deleteMessage silently returns if it can't find the
    // .mes[mesid="..."] element (which happens during some streaming finishes).
    const ctxAfter = getContext();
    const chatArr = ctxAfter.chat;
    if (Array.isArray(chatArr) && targetMessage && chatArr[id] === targetMessage) {
        chatArr.splice(id, 1);
        console.warn(`[${EXT_NAME}] deleteMessage did not remove ${label} from chat array; spliced manually.`);
    }
    const stragglerEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (stragglerEl && Array.isArray(chatArr) && chatArr[id] !== targetMessage) {
        stragglerEl.remove();
    }
    return deleted;
}

async function maybeHandleUnpromptedMessage(messageId) {
    if (!pendingNotification) return;

    const ctx = getContext();
    const chatKey = getChatKey(ctx);
    const message = ctx.chat?.[messageId];
    if (chatKey !== pendingNotification.chatKey || !message || message.is_user || message.is_system) return;

    const text = String(message.mes || '');

    if (TRY_LATER_RE.test(text)) {
        pendingNotification = null;
        tryLaterDetected = true;
        updateStatus('Idle: will try again next check.');
        await robustDeleteMessage(messageId, '[trylater]');
        return;
    }

    if (SAY_NOTHING_RE.test(text)) {
        pendingNotification = null;
        const state = getChatState(chatKey);
        state.silentUntilUserMessage = true;
        state.lastCheckedAt = Date.now();
        saveSettingsDebounced();
        updateStatus('Paused by [saynothing] until user replies.');
        await robustDeleteMessage(messageId, '[saynothing]');
        return;
    }

    pendingNotification = null;
    showBrowserNotification(message);
}

function renderPromptRow(prompt, index) {
    return `
<div class="unprompted-prompt" data-id="${escHtml(prompt.id)}">
    <div class="unprompted-prompt-head">
        <label class="checkbox_label unprompted-enabled">
            <input class="unprompted-prompt-enabled" type="checkbox" ${prompt.enabled ? 'checked' : ''}>
            <span>Prompt ${index + 1}</span>
        </label>
        <input class="text_pole unprompted-prompt-label" type="text" value="${escHtml(prompt.label)}" title="Prompt label">
        <label class="unprompted-weight-wrap" title="Relative weight — higher weight = more likely to be picked">
            <span>Weight</span>
            <input class="text_pole unprompted-prompt-weight" type="number" min="0.01" step="0.01" value="${escHtml(prompt.weight)}">
            <span class="unprompted-chance"></span>
        </label>
        <button class="menu_button menu_button_icon unprompted-delete" title="Delete prompt">
            <span aria-hidden="true">🗑️</span>
        </button>
    </div>
    <textarea class="text_pole unprompted-prompt-text" rows="4" spellcheck="false">${escHtml(prompt.prompt)}</textarea>
</div>`;
}

function updatePromptChances() {
    const s = getSettings();
    const list = document.getElementById('unprompted_prompt_list');
    if (!list) return;
    const promptMap = new Map(s.prompts.map(p => [p.id, p]));
    const eligible = s.prompts.filter(p => p.enabled && positiveNumber(p.weight, 0) > 0 && String(p.prompt || '').trim());
    const total = eligible.reduce((sum, p) => sum + positiveNumber(p.weight, 0), 0);
    list.querySelectorAll('.unprompted-prompt').forEach(row => {
        const prompt = promptMap.get(row.dataset.id);
        const el = row.querySelector('.unprompted-chance');
        if (!el || !prompt) return;
        const weight = positiveNumber(prompt.weight, 0);
        const isEligible = prompt.enabled && weight > 0 && String(prompt.prompt || '').trim();
        if (!isEligible || total <= 0) {
            el.textContent = '';
            el.title = '';
        } else {
            el.textContent = `= ${(weight / total * 100).toFixed(1)}%`;
            el.title = 'Chance of being selected when this prompt fires';
        }
    });
}

function renderPromptList() {
    const list = document.getElementById('unprompted_prompt_list');
    if (!list) return;
    list.innerHTML = getSettings().prompts.map(renderPromptRow).join('');
    updatePromptChances();
}

function writePromptFromRow(row) {
    const id = row.dataset.id;
    const prompt = getSettings().prompts.find(item => item.id === id);
    if (!prompt) return;
    prompt.enabled = !!row.querySelector('.unprompted-prompt-enabled')?.checked;
    prompt.label = row.querySelector('.unprompted-prompt-label')?.value || 'Unprompted prompt';
    prompt.weight = positiveNumber(row.querySelector('.unprompted-prompt-weight')?.value, 1);
    prompt.prompt = row.querySelector('.unprompted-prompt-text')?.value || '';
}

function addSettingsUI() {
    const s = getSettings();
    const html = `
<div id="unprompted_panel" class="unprompted-panel">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label unprompted-row">
                <input id="unprompted_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>
                <span>Enabled</span>
            </label>

            <div class="unprompted-grid">
                <label>
                    <span>Check every</span>
                    <input id="unprompted_check_minutes" class="text_pole" type="number" min="1" step="1" value="${escHtml(s.checkMinutes)}">
                    <span>min</span>
                    <span id="unprompted_timer_display" class="unprompted-timer-display"></span>
                </label>
                <label>
                    <span>Cooldown</span>
                    <input id="unprompted_cooldown_minutes" class="text_pole" type="number" min="0.01" step="0.01" value="${escHtml(s.cooldownMinutes)}">
                    <span>min</span>
                </label>
                <label>
                    <span>Max nonuser in row</span>
                    <input id="unprompted_max_ai" class="text_pole" type="number" min="1" step="1" value="${escHtml(s.maxAiInRow)}">
                    <span id="unprompted_max_ai_warning" class="unprompted-warning"${s.maxAiInRow >= 2 ? ' hidden' : ''}>invalid — AI can't send if &lt;2</span>
                </label>
            </div>

            <label class="checkbox_label unprompted-row">
                <input id="unprompted_run_on_chat_open" type="checkbox" ${s.runOnChatOpen ? 'checked' : ''}>
                <span>Roll after opening a chat if cooldown allows</span>
            </label>
            <label class="checkbox_label unprompted-row">
                <input id="unprompted_reset_on_send" type="checkbox" ${s.resetTimerOnUserMessage ? 'checked' : ''}>
                <span>Reset timer on user message send</span>
            </label>
            <label class="checkbox_label unprompted-row">
                <input id="unprompted_browser_notifications" type="checkbox" ${s.browserNotifications ? 'checked' : ''}>
                <span>Browser notifications</span>
            </label>
            <div id="unprompted_notification_note" class="unprompted-note"></div>

            <div class="unprompted-actions">
                <button id="unprompted_test" class="menu_button menu_button_icon" title="Try to send one now">
                    <i class="fa-solid fa-paper-plane"></i>
                    <span>Roll now</span>
                </button>
                <button id="unprompted_add_prompt" class="menu_button menu_button_icon" title="Add prompt">
                    <i class="fa-solid fa-plus"></i>
                    <span>Add prompt</span>
                </button>
            </div>

            <div id="unprompted_status" class="unprompted-status"></div>
            <div class="unprompted-macro-note"><a href="https://github.com/shikaku2/st-unprompted#custom-macros" target="_blank" rel="noopener noreferrer">more instructions and macro definitions</a>. Context macros: [lastmessages=1], [lastexchanges=1], [1d], [1w], [168h], [1m], combined forms like [1m2d6h]. Duration aliases work too: [lastmessages=1w], [lastexchanges=7d]. Duration macros also pull in messages from other recent chat files with this character. AI output macros: [saynothing] (skip, pause until user replies), [trylater] (skip, retry next check).</div>
            <div id="unprompted_prompt_list" class="unprompted-prompt-list"></div>
        </div>
    </div>
</div>`;

    $('#extensions_settings2').append(html);
    renderPromptList();

    $('#unprompted_enabled').on('change', function () {
        getSettings().enabled = !!this.checked;
        saveSettingsDebounced();
        restartTimer();
        updateTimerDisplay();
    });
    $('#unprompted_check_minutes').on('change', function () {
        getSettings().checkMinutes = clampInteger(this.value, 1, DEFAULT_SETTINGS.checkMinutes);
        this.value = getSettings().checkMinutes;
        saveSettingsDebounced();
        restartTimer();
    });
    $('#unprompted_cooldown_minutes').on('change', function () {
        getSettings().cooldownMinutes = positiveNumber(this.value, DEFAULT_SETTINGS.cooldownMinutes);
        this.value = getSettings().cooldownMinutes;
        saveSettingsDebounced();
    });
    $('#unprompted_max_ai').on('change', function () {
        getSettings().maxAiInRow = clampInteger(this.value, 1, DEFAULT_SETTINGS.maxAiInRow);
        this.value = getSettings().maxAiInRow;
        saveSettingsDebounced();
        const warning = document.getElementById('unprompted_max_ai_warning');
        if (warning) warning.hidden = getSettings().maxAiInRow >= 2;
    });
    $('#unprompted_run_on_chat_open').on('change', function () {
        getSettings().runOnChatOpen = !!this.checked;
        saveSettingsDebounced();
    });
    $('#unprompted_reset_on_send').on('change', function () {
        getSettings().resetTimerOnUserMessage = !!this.checked;
        saveSettingsDebounced();
    });
    $('#unprompted_browser_notifications').on('change', function () {
        requestBrowserNotificationSetting(!!this.checked);
    });
    $('#unprompted_test').on('click', () => trySendUnprompted(true));
    $('#unprompted_add_prompt').on('click', () => {
        getSettings().prompts.push(normalizePrompt({
            label: 'Custom prompt',
            weight: 1,
            prompt: 'Send an unprompted message. Context:\n[lastmessages=3]',
        }));
        renderPromptList();
        saveSettingsDebounced();
    });

    $('#unprompted_prompt_list').on('change input', '.unprompted-prompt input, .unprompted-prompt textarea', function () {
        const row = this.closest('.unprompted-prompt');
        if (!row) return;
        writePromptFromRow(row);
        updatePromptChances();
        saveSettingsDebounced();
    });
    $('#unprompted_prompt_list').on('click', '.unprompted-delete', function () {
        const row = this.closest('.unprompted-prompt');
        if (!row) return;
        getSettings().prompts = getSettings().prompts.filter(prompt => prompt.id !== row.dataset.id);
        renderPromptList();
        saveSettingsDebounced();
    });

    syncNotificationUI();
}

jQuery(async () => {
    loadSettings();
    addSettingsUI();

    eventSource.on(event_types.GENERATION_STOPPED, () => {
        unpromptedInFlight = false;
        pendingNotification = null;
        tryLaterDetected = false;
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, maybeHandleUnpromptedMessage);
    eventSource.on(event_types.MESSAGE_SENT, () => {
        const chatKey = getChatKey();
        if (!chatKey) return;
        const state = getChatState(chatKey);
        state.lastCheckedAt = Date.now();
        state.silentUntilUserMessage = false;
        saveSettingsDebounced();
        if (getSettings().resetTimerOnUserMessage && getSettings().enabled) startTimer();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        otherChatMessagesCache.key = '';
        restartTimer();
        if (getSettings().enabled && getSettings().runOnChatOpen) {
            setTimeout(() => trySendUnprompted(false), 1500);
        }
    });
    window.addEventListener('focus', syncNotificationUI);

    restartTimer();
    console.log(`[${EXT_NAME}] Loaded`);
});
