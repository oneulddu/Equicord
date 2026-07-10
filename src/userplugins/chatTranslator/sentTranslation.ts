/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { settings as TranslateSettings } from "@plugins/translate/settings";
import { Logger } from "@utils/Logger";
import { showToast, Toasts } from "@webpack/common";

import { settings } from "./settings";
import { isAbortError, runLimitedTranslation } from "./translationState";
import {
    getAutomaticTranslationSkipReason,
    getManualTranslationBlockReason,
    hasMeaningfulTextForTranslation,
    normalizeTranslationFailureReason,
    translate
} from "./utils";

const ManualNextSendListeners = new Set<(enabled: boolean) => void>();
const ActiveOutgoingTranslationControllers = new Set<AbortController>();
const SentTranslationLogger = new Logger("ChatTranslatorSent");
let manualTranslateNextSend = false;
let cachedSentChannelOverrides: { raw: string; value: Record<string, boolean>; } | undefined;

function notifyManualNextSend() {
    for (const listener of ManualNextSendListeners)
        listener(manualTranslateNextSend);
}

export function isManualTranslateNextSendEnabled() {
    return manualTranslateNextSend;
}

export function setManualTranslateNextSend(enabled: boolean) {
    if (manualTranslateNextSend === enabled) return;

    manualTranslateNextSend = enabled;
    notifyManualNextSend();
}

export function toggleManualTranslateNextSend() {
    setManualTranslateNextSend(!manualTranslateNextSend);
    return manualTranslateNextSend;
}

export function consumeManualTranslateNextSend() {
    if (!manualTranslateNextSend) return false;

    setManualTranslateNextSend(false);
    return true;
}

export function subscribeManualTranslateNextSend(listener: (enabled: boolean) => void) {
    ManualNextSendListeners.add(listener);

    return () => {
        ManualNextSendListeners.delete(listener);
    };
}

function shouldSkipSentMessage(content: string) {
    if (!content || !hasMeaningfulTextForTranslation(content)) return true;
    if (content.trim().startsWith("/")) return true;

    return !!getAutomaticTranslationSkipReason(content);
}

function getManualSentSkipReason(content: string) {
    if (!content || content.trim().startsWith("/"))
        return "Skipped: commands are not translated";

    return getManualTranslationBlockReason(content)?.reason ?? null;
}

export async function translateOutgoingMessage(channelId: string | undefined, content: string) {
    const manualRequested = isManualTranslateNextSendEnabled();
    const manualSkipReason = manualRequested ? getManualSentSkipReason(content) : null;
    const coreTranslateHandlesSend = isPluginEnabled("Translate") && TranslateSettings.store.autoTranslate;
    const shouldManualTranslate = !coreTranslateHandlesSend && manualRequested && !manualSkipReason;
    const shouldAutoTranslate = !coreTranslateHandlesSend
        && getSentAutoTranslateChannelState(channelId)
        && !shouldSkipSentMessage(content);

    if (manualRequested && (content.trim() || manualSkipReason))
        consumeManualTranslateNextSend();

    if (!shouldAutoTranslate && !shouldManualTranslate) {
        if (manualSkipReason)
            showToast(manualSkipReason, Toasts.Type.FAILURE);

        return null;
    }

    const controller = new AbortController();
    ActiveOutgoingTranslationControllers.add(controller);

    try {
        const translated = await runLimitedTranslation(
            controller.signal,
            signal => translate("sent", content, { ignoreConfidenceRequirement: true }, signal)
        );
        const translatedText = translated.text.trim();

        if (!translatedText || translatedText === content.trim())
            return null;

        if (shouldManualTranslate)
            showToast("Translated this outgoing message.", Toasts.Type.SUCCESS);

        return translatedText;
    } catch (error) {
        if (isAbortError(error)) return null;

        showToast(normalizeTranslationFailureReason(error), Toasts.Type.FAILURE);
        return null;
    } finally {
        ActiveOutgoingTranslationControllers.delete(controller);
    }
}

export function stopSentTranslation() {
    for (const controller of ActiveOutgoingTranslationControllers)
        controller.abort();

    ActiveOutgoingTranslationControllers.clear();
    manualTranslateNextSend = false;
    cachedSentChannelOverrides = undefined;
    notifyManualNextSend();
    ManualNextSendListeners.clear();
}

export function getSentAutoTranslateChannelState(channelId?: string | null, globalEnabled = settings.store.autoTranslate, raw = settings.store.sentChannelOverrides) {
    if (!channelId) return globalEnabled;

    const overrides = parseSentChannelOverrides(raw);
    return overrides[channelId] ?? globalEnabled;
}

export function hasSentAutoTranslateChannelOverride(channelId?: string | null, raw = settings.store.sentChannelOverrides) {
    if (!channelId) return false;

    return Object.prototype.hasOwnProperty.call(parseSentChannelOverrides(raw), channelId);
}

export function setSentAutoTranslateChannelState(channelId: string, enabled: boolean, globalEnabled = settings.store.autoTranslate, raw = settings.store.sentChannelOverrides) {
    const overrides = { ...parseSentChannelOverrides(raw) };

    if (enabled === globalEnabled)
        delete overrides[channelId];
    else
        overrides[channelId] = enabled;

    settings.store.sentChannelOverrides = JSON.stringify(overrides);
}

export function clearSentAutoTranslateChannelOverride(channelId: string, raw = settings.store.sentChannelOverrides) {
    const overrides = { ...parseSentChannelOverrides(raw) };
    delete overrides[channelId];
    settings.store.sentChannelOverrides = JSON.stringify(overrides);
}

function parseSentChannelOverrides(raw = "{}") {
    const normalizedRaw = raw || "{}";
    if (cachedSentChannelOverrides?.raw === normalizedRaw)
        return cachedSentChannelOverrides.value;

    let value: Record<string, boolean>;

    try {
        const parsed: unknown = JSON.parse(normalizedRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            value = {};
        else
            value = Object.fromEntries(
                Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean")
            );
    } catch (error) {
        SentTranslationLogger.warn("Failed to parse sent channel overrides", error);
        value = {};
    }

    cachedSentChannelOverrides = { raw: normalizedRaw, value };
    return value;
}
