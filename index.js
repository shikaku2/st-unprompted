import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { Generate, deleteMessage, saveSettingsDebounced, substituteParams } from '../../../../script.js';

const EXT_NAME = 'unprompted';
const DISPLAY_NAME = 'Unprompted Messages';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SAY_NOTHING_RE = /\[saynothing\]/i;
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
    browserNotifications: false,
    prompts: DEFAULT_PROMPTS,
    stateByChat: {},
};

let checkTimer = null;
let unpromptedInFlight = false;
let pendingNotification = null;

function getSettings() {
    return extension_settings[EXT_NAME];
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadSettings() {
    const existing = extension_settings[EXT_NAME] || {};
    const merged = Object.assign(clone(DEFAULT_SETTINGS), existing);
    merged.cooldownMinutes = normalizeCooldownMinutes(existing);
    delete merged.cooldownHours;
    merged.prompts = Array.isArray(existing.prompts) && existing.prompts.length
        ? existing.prompts.map(normalizePrompt)
        : clone(DEFAULT_PROMPTS);
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

function durationToMs(raw) {
    const compact = String(raw || '').trim().toLowerCase();
    if (!compact) return 0;

    let total = 0;
    const re = /(\d+(?:\.\d+)?)(m|d|h)/g;
    let match;
    while ((match = re.exec(compact)) !== null) {
        const amount = Number(match[1]);
        const unit = match[2];
        if (unit === 'm') total += amount * MONTH_MS;
        if (unit === 'd') total += amount * DAY_MS;
        if (unit === 'h') total += amount * HOUR_MS;
    }
    return total;
}

function expandCustomMacros(prompt) {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];

    let expanded = String(prompt || '');

    expanded = expanded.replace(/\[lastmessages=(\d+)\]/gi, (_match, countRaw) => {
        const messages = getRecentMessagesByCount(chat, clampInteger(countRaw, 1, 1));
        return messages.map(formatMessage).filter(Boolean).join('\n') || '(no recent messages)';
    });

    expanded = expanded.replace(/\[lastexchanges=(\d+)\]/gi, (_match, countRaw) => {
        const messages = getRecentMessagesByExchangeCount(chat, clampInteger(countRaw, 1, 1));
        return messages.map(formatMessage).filter(Boolean).join('\n') || '(no recent exchanges)';
    });

    expanded = expanded.replace(/\[((?:\d+(?:\.\d+)?[mdh])+)\]/gi, (_match, durationRaw) => {
        const messages = getRecentMessagesByAge(chat, durationToMs(durationRaw));
        return messages.map(formatMessage).filter(Boolean).join('\n') || `(no messages in the last ${durationRaw})`;
    });

    try {
        expanded = substituteParams(expanded);
    } catch (err) {
        console.warn(`[${EXT_NAME}] Failed to substitute SillyTavern macros`, err);
    }

    return expanded.trim();
}

function addSayNothingInstruction(prompt) {
    const trimmed = String(prompt || '').trim();
    if (!trimmed || SAY_NOTHING_RE.test(trimmed)) return trimmed;
    return `${trimmed}\n\n${expandCustomMacros(SAY_NOTHING_INSTRUCTION)}`;
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

    const quietPrompt = addSayNothingInstruction(expandCustomMacros(selected.prompt));
    if (!quietPrompt) {
        updateStatus('Selected prompt expanded to empty text.');
        if (manual) toastr.warning('Selected prompt expanded to empty text.', DISPLAY_NAME);
        return false;
    }

    allowed.state.lastCheckedAt = Date.now();
    saveSettingsDebounced();
    updateStatus(`Sending: ${selected.label}`);

    unpromptedInFlight = true;
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

function startTimer() {
    stopTimer();
    const s = getSettings();
    if (!s.enabled) return;

    const intervalMs = positiveNumber(s.checkMinutes, DEFAULT_SETTINGS.checkMinutes) * MINUTE_MS;
    checkTimer = setInterval(() => trySendUnprompted(false), intervalMs);
    updateStatus(`Checking every ${s.checkMinutes} min.`);
}

function stopTimer() {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
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

async function maybeHandleUnpromptedMessage(messageId) {
    if (!pendingNotification) return;

    const ctx = getContext();
    const chatKey = getChatKey(ctx);
    const message = ctx.chat?.[messageId];
    if (chatKey !== pendingNotification.chatKey || !message || message.is_user || message.is_system) return;

    if (SAY_NOTHING_RE.test(String(message.mes || ''))) {
        pendingNotification = null;
        const state = getChatState(chatKey);
        state.silentUntilUserMessage = true;
        state.lastCheckedAt = Date.now();
        saveSettingsDebounced();
        updateStatus('Paused by [saynothing] until user replies.');
        try {
            await deleteMessage(Number(messageId), undefined, false);
        } catch (err) {
            console.error(`[${EXT_NAME}] Failed to delete [saynothing] message`, err);
            updateStatus('Failed to delete [saynothing] message. Check console.');
        }
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
        <label class="unprompted-weight-wrap" title="Relative weight">
            <span>Weight</span>
            <input class="text_pole unprompted-prompt-weight" type="number" min="0.01" step="0.01" value="${escHtml(prompt.weight)}">
        </label>
        <button class="menu_button menu_button_icon unprompted-delete" title="Delete prompt">
            <span aria-hidden="true">🗑️</span>
        </button>
    </div>
    <textarea class="text_pole unprompted-prompt-text" rows="4" spellcheck="false">${escHtml(prompt.prompt)}</textarea>
</div>`;
}

function renderPromptList() {
    const list = document.getElementById('unprompted_prompt_list');
    if (!list) return;
    list.innerHTML = getSettings().prompts.map(renderPromptRow).join('');
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
                </label>
                <label>
                    <span>Cooldown</span>
                    <input id="unprompted_cooldown_minutes" class="text_pole" type="number" min="0.01" step="0.01" value="${escHtml(s.cooldownMinutes)}">
                    <span>min</span>
                </label>
                <label>
                    <span>Max nonuser in row</span>
                    <input id="unprompted_max_ai" class="text_pole" type="number" min="1" step="1" value="${escHtml(s.maxAiInRow)}">
                </label>
            </div>

            <label class="checkbox_label unprompted-row">
                <input id="unprompted_run_on_chat_open" type="checkbox" ${s.runOnChatOpen ? 'checked' : ''}>
                <span>Roll after opening a chat if cooldown allows</span>
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
            <div class="unprompted-macro-note">Custom macros: [lastmessages=1], [lastexchanges=1], [1d], [168h], [1m], or combined forms like [1m2d6h].</div>
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
    });
    $('#unprompted_run_on_chat_open').on('change', function () {
        getSettings().runOnChatOpen = !!this.checked;
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
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, maybeHandleUnpromptedMessage);
    eventSource.on(event_types.MESSAGE_SENT, () => {
        const chatKey = getChatKey();
        if (!chatKey) return;
        const state = getChatState(chatKey);
        state.lastCheckedAt = Date.now();
        state.silentUntilUserMessage = false;
        saveSettingsDebounced();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        restartTimer();
        if (getSettings().enabled && getSettings().runOnChatOpen) {
            setTimeout(() => trySendUnprompted(false), 1500);
        }
    });
    window.addEventListener('focus', syncNotificationUI);

    restartTimer();
    console.log(`[${EXT_NAME}] Loaded`);
});
