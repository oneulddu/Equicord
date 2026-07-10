/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 oneulffu
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Message } from "@vencord/discord-types";
import { FluxDispatcher, MessageStore, Parser, showToast, Toasts, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import {
    clearPersistentTranslationCache,
    deleteCachedTranslation,
    deleteCachedTranslations,
    deleteReplacedMessageSourceLanguage,
    ensurePersistentCacheLoaded,
    getCachedTranslation,
    getCachedTranslationForRender,
    isPersistentCacheLoaded,
    notifyTranslationCacheStatsChanged,
    peekCachedTranslation,
    pruneOldestEntries,
    schedulePersistentCacheFlush,
    setActiveCacheSignature,
    setCachedTranslation,
    setReplacedMessageSourceLanguage,
    subscribePersistentCacheLoaded,
    subscribeVisibleCacheDeletes,
    touchCachedTranslation
} from "./cache";
import { settings } from "./settings";
import { TranslateIcon } from "./TranslateIcon";
import {
    cancelTranslationRequest,
    cancelTranslationRequests,
    clearTranslationRequests,
    isTranslationRequestPending,
    queueTranslationRequest,
    type TranslationRequestIdentity
} from "./translationState";
import {
    cl,
    getAutomaticMessageSkipReason,
    getMessageChannelId,
    getMessageContent,
    getReceivedAutoTranslateChannelState,
    getReceivedTranslationCacheSignatureFromValues,
    getReceivedTranslationOptionsForChannel,
    normalizeTranslationFailureReason,
    translate,
    TranslationSkipResult,
    TranslationValue
} from "./utils";

export {
    getReplacedMessageSourceLanguage,
    getTranslationCacheStats,
    getTranslationCacheStatsVersion,
    pruneExpiredTranslationCache,
    subscribeTranslationCacheStatsVersion
} from "./cache";

type SettingKey = keyof typeof settings.store;

interface TranslationNotice {
    kind: "skip" | "failure";
    message: string;
    canTranslateManually: boolean;
    quiet?: boolean;
}

interface TranslationDisplayState {
    channelId?: string;
    expanded: boolean;
    view: "translation" | "original";
}

interface FailedTranslation {
    channelId?: string;
    content: string;
    cacheSignature: string;
    requestSignature: string;
    notice: TranslationNotice;
}

const ACCESSORY_SETTING_KEYS: SettingKey[] = [
    "autoTranslateReceived",
    "collapseTranslatedMessages",
    "replaceMessageContent",
    "simpleMode",
    "receivedDisplayMode",
    "receivedChannelOverrides",
    "receivedChannelInputOverrides",
    "receivedChannelOutputOverrides",
    "service",
    "receivedInput",
    "receivedOutput",
    "deeplApiKey",
    "azureApiKey",
    "azureRegion",
    "azureEndpoint",
    "showTranslationFailureReasons",
    "autoTranslateMaxCharacters",
    "autoTranslateMaxLines",
    "googleConfidenceRequirement",
    "translationCacheTtlDays",
    "skipCodeBlockMessages",
    "skipAlreadyTranslatedMessages",
    "skipBotMessages",
    "ignoredGuilds",
    "ignoredChannels",
    "ignoredUsers"
];

const TranslationSetters = new Map<string, (v: TranslationValue | undefined) => void>();
const TranslationLoadingSetters = new Map<string, (v: boolean) => void>();
const TranslationNoticeSetters = new Map<string, (v: TranslationNotice | undefined) => void>();
const VisibleMessages = new Map<string, Message>();
const DismissedTranslations = new Map<string, { channelId?: string; content: string; cacheSignature: string; }>();
const FailedTranslations = new Map<string, FailedTranslation>();
const ManualTranslations = new Map<string, { channelId?: string; content: string; cacheSignature: string; }>();
const TranslationDisplayStates = new Map<string, TranslationDisplayState>();
let unsubscribeVisibleCacheDeletes: (() => void) | undefined;

function requestMessageRerender(messageId: string) {
    const message = VisibleMessages.get(messageId);
    if (!message) return;

    FluxDispatcher.dispatch({
        type: "MESSAGE_UPDATE",
        message
    });
}

function handleVisibleCacheDelete(messageId: string) {
    TranslationSetters.get(messageId)?.(undefined);
    TranslationLoadingSetters.get(messageId)?.(false);
    TranslationNoticeSetters.get(messageId)?.(undefined);
    requestMessageRerender(messageId);
}

export function startTranslationRuntime() {
    unsubscribeVisibleCacheDeletes ??= subscribeVisibleCacheDeletes(handleVisibleCacheDelete);
}

export function stopTranslationRuntime() {
    unsubscribeVisibleCacheDeletes?.();
    unsubscribeVisibleCacheDeletes = undefined;
    clearTranslationRequests(true);

    for (const setter of TranslationSetters.values())
        setter(undefined);

    for (const setter of TranslationLoadingSetters.values())
        setter(false);

    for (const setter of TranslationNoticeSetters.values())
        setter(undefined);

    TranslationSetters.clear();
    TranslationLoadingSetters.clear();
    TranslationNoticeSetters.clear();
    VisibleMessages.clear();
    DismissedTranslations.clear();
    FailedTranslations.clear();
    ManualTranslations.clear();
    TranslationDisplayStates.clear();
}

export function getReplacedMessageContent(message: Message) {
    if (!settings.store.replaceMessageContent) {
        deleteReplacedMessageSourceLanguage(message.id);
        return message;
    }

    const content = getMessageContent(message);
    if (!content) {
        deleteReplacedMessageSourceLanguage(message.id);
        return message;
    }

    const cached = getCachedTranslationForRender(message.id);
    if (!cached || cached.content !== content) {
        deleteReplacedMessageSourceLanguage(message.id);
        return message;
    }

    const channelId = getMessageChannelId(message);
    const translationOptions = getReceivedTranslationOptionsForChannel(
        channelId,
        settings.store.receivedInput,
        settings.store.receivedOutput,
        settings.store.receivedChannelInputOverrides,
        settings.store.receivedChannelOutputOverrides
    );
    const cacheSignature = getReceivedTranslationCacheSignatureFromValues(
        translationOptions.sourceLang,
        translationOptions.targetLang
    );

    if (cached.cacheSignature !== cacheSignature) {
        deleteReplacedMessageSourceLanguage(message.id);
        return message;
    }

    const manualTranslation = ManualTranslations.get(message.id);
    const isManualTranslation = manualTranslation?.content === content
        && manualTranslation.cacheSignature === cacheSignature
        && manualTranslation.channelId === channelId;
    const dismissedTranslation = DismissedTranslations.get(message.id);
    const isDismissed = dismissedTranslation?.content === content
        && dismissedTranslation.cacheSignature === cacheSignature
        && dismissedTranslation.channelId === channelId;
    const currentUserId = UserStore.getCurrentUser()?.id;
    const isOwnMessage = currentUserId != null && String(message.author?.id) === String(currentUserId);
    const autoTranslateEnabled = getReceivedAutoTranslateChannelState(
        channelId,
        settings.store.autoTranslateReceived,
        settings.store.receivedChannelOverrides
    );
    const lowConfidenceNotice = getLowConfidenceNotice(
        cached.translation,
        IS_WEB ? "google" : settings.store.service,
        Number(settings.store.googleConfidenceRequirement) || 0
    );

    if (!isManualTranslation && (
        !autoTranslateEnabled
        || isOwnMessage
        || isDismissed
        || !!getAutomaticMessageSkipReason(message, content)
        || !!lowConfidenceNotice
    )) {
        deleteReplacedMessageSourceLanguage(message.id);
        return message;
    }

    setReplacedMessageSourceLanguage(message.id, cached.translation.sourceLanguage);

    return Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
        content: cached.translation.text
    }) as Message;
}

export async function clearTranslationCache() {
    clearTranslationRequests();
    DismissedTranslations.clear();
    FailedTranslations.clear();
    ManualTranslations.clear();
    TranslationDisplayStates.clear();

    for (const setter of TranslationSetters.values())
        setter(undefined);

    for (const setter of TranslationLoadingSetters.values())
        setter(false);

    for (const setter of TranslationNoticeSetters.values())
        setter(undefined);

    await clearPersistentTranslationCache();
}

function isMessageContentCurrent(messageId: string, channelId: string | undefined, content: string) {
    const visibleMessage = VisibleMessages.get(messageId);
    if (visibleMessage && getMessageContent(visibleMessage) !== content)
        return false;

    const storedMessage = channelId ? MessageStore.getMessage(channelId, messageId) : undefined;
    return !storedMessage || getMessageContent(storedMessage) === content;
}

function applyTranslation(messageId: string, channelId: string | undefined, content: string, cacheSignature: string, translation: TranslationValue) {
    if (!isMessageContentCurrent(messageId, channelId, content)) return false;

    setCachedTranslation(messageId, channelId, content, cacheSignature, translation);
    schedulePersistentCacheFlush();
    DismissedTranslations.delete(messageId);
    FailedTranslations.delete(messageId);
    TranslationSetters.get(messageId)?.(translation);
    TranslationNoticeSetters.get(messageId)?.(undefined);
    requestMessageRerender(messageId);
    notifyTranslationCacheStatsChanged();
    return true;
}

export function handleManualTranslateResult(
    messageId: string,
    channelId: string | undefined,
    content: string,
    translation: TranslationValue,
    cacheSignature: string
) {
    if (!isMessageContentCurrent(messageId, channelId, content)) return;

    ManualTranslations.set(messageId, { channelId, content, cacheSignature });
    FailedTranslations.delete(messageId);
    pruneOldestEntries(ManualTranslations);
    applyTranslation(messageId, channelId, content, cacheSignature, translation);
    TranslationLoadingSetters.get(messageId)?.(false);
}

function createSecretFingerprint(secret?: string) {
    const trimmedSecret = secret?.trim();
    if (!trimmedSecret)
        return "missing";

    let hash = 0;
    for (let i = 0; i < trimmedSecret.length; i++)
        hash = ((hash << 5) - hash + trimmedSecret.charCodeAt(i)) >>> 0;

    return `${trimmedSecret.length}:${hash.toString(36)}`;
}

function getReceivedTranslationRequestSignature({
    service,
    receivedInput,
    receivedOutput,
    deeplApiKey,
    azureApiKey,
    azureRegion,
    azureEndpoint,
    googleConfidenceRequirement,
    ignoreConfidenceRequirement = false
}: {
    service?: string;
    receivedInput?: string;
    receivedOutput?: string;
    deeplApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    azureEndpoint?: string;
    googleConfidenceRequirement?: number;
    ignoreConfidenceRequirement?: boolean;
}) {
    return [
        service ?? "",
        receivedInput ?? "",
        receivedOutput ?? "",
        service === "deepl" || service === "deepl-pro" ? createSecretFingerprint(deeplApiKey) : "",
        service === "azure" ? createSecretFingerprint(azureApiKey) : "",
        service === "azure" ? azureRegion?.trim() ?? "" : "",
        service === "azure" ? azureEndpoint?.trim() ?? "" : "",
        service === "google" ? Number(googleConfidenceRequirement) || 0 : "",
        ignoreConfidenceRequirement ? "manual" : "automatic"
    ].join("::");
}

function getCurrentReceivedTranslationState(channelId: string | undefined, ignoreConfidenceRequirement = false) {
    const translationOptions = getReceivedTranslationOptionsForChannel(
        channelId,
        settings.store.receivedInput,
        settings.store.receivedOutput,
        settings.store.receivedChannelInputOverrides,
        settings.store.receivedChannelOutputOverrides
    );
    const cacheSignature = getReceivedTranslationCacheSignatureFromValues(
        translationOptions.sourceLang,
        translationOptions.targetLang
    );
    const requestSignature = getReceivedTranslationRequestSignature({
        service: IS_WEB ? "google" : settings.store.service,
        receivedInput: translationOptions.sourceLang,
        receivedOutput: translationOptions.targetLang,
        deeplApiKey: settings.store.deeplApiKey,
        azureApiKey: settings.store.azureApiKey,
        azureRegion: settings.store.azureRegion,
        azureEndpoint: settings.store.azureEndpoint,
        googleConfidenceRequirement: settings.store.googleConfidenceRequirement,
        ignoreConfidenceRequirement
    });

    return { cacheSignature, requestSignature, translationOptions };
}

function setTranslationNotice(messageId: string, notice: TranslationNotice | undefined) {
    if (notice)
        TranslationNoticeSetters.get(messageId)?.(notice);
    else
        TranslationNoticeSetters.get(messageId)?.(undefined);
}

function setTranslationDisplayState(messageId: string, state: TranslationDisplayState) {
    TranslationDisplayStates.set(messageId, state);
    pruneOldestEntries(TranslationDisplayStates);
}

function getTranslationDisplayState(messageId: string, channelId: string | undefined, defaultCollapsed: boolean, displayMode: string): TranslationDisplayState {
    const storedState = TranslationDisplayStates.get(messageId);
    if (storedState && storedState.channelId === channelId)
        return storedState;

    return {
        channelId,
        expanded: !defaultCollapsed,
        view: displayMode === "toggle" ? "translation" : "translation"
    };
}

function createSkipNotice(skipResult: TranslationSkipResult): TranslationNotice {
    return {
        kind: "skip",
        message: skipResult.reason,
        canTranslateManually: skipResult.canTranslateManually,
        quiet: !skipResult.canTranslateManually
    };
}

function createFailureNotice(error: unknown): TranslationNotice {
    return {
        kind: "failure",
        message: normalizeTranslationFailureReason(error),
        canTranslateManually: true
    };
}

function createLowConfidenceNotice(confidence: number, requiredConfidence: number): TranslationNotice {
    return {
        kind: "skip",
        message: `Skipped: low Google detection confidence (${confidence.toFixed(2)} < ${requiredConfidence.toFixed(2)})`,
        canTranslateManually: true
    };
}

function getLowConfidenceNotice(translation: TranslationValue, service: string | undefined, requiredConfidence: number): TranslationNotice | undefined {
    if (service !== "google") return undefined;
    if (!requiredConfidence) return undefined;
    if (translation.confidence == null) return undefined;
    if (translation.confidence >= requiredConfidence) return undefined;

    return createLowConfidenceNotice(translation.confidence, requiredConfidence);
}

function ensureFreshState(cacheSignature: string) {
    setActiveCacheSignature(cacheSignature);
}

function resetMessageTranslationStateIfContentChanged(messageId: string, content: string) {
    let resetDisplayState = false;
    let cacheChanged = false;

    const cached = peekCachedTranslation(messageId);
    if (cached && cached.content !== content) {
        deleteCachedTranslation(messageId);
        cacheChanged = true;
        resetDisplayState = true;
    }

    const manual = ManualTranslations.get(messageId);
    if (manual && manual.content !== content) {
        ManualTranslations.delete(messageId);
        resetDisplayState = true;
    }

    const dismissed = DismissedTranslations.get(messageId);
    if (dismissed && dismissed.content !== content) {
        DismissedTranslations.delete(messageId);
        resetDisplayState = true;
    }

    const failed = FailedTranslations.get(messageId);
    if (failed && failed.content !== content) {
        FailedTranslations.delete(messageId);
        resetDisplayState = true;
    }

    const cancelledRequests = cancelTranslationRequests(request => request.messageId === messageId && request.content !== content);
    if (cancelledRequests.length) {
        TranslationLoadingSetters.get(messageId)?.(false);
        resetDisplayState = true;
    }

    if (resetDisplayState) {
        TranslationDisplayStates.delete(messageId);
        deleteReplacedMessageSourceLanguage(messageId);
    }

    if (cacheChanged) {
        schedulePersistentCacheFlush();
        notifyTranslationCacheStatsChanged();
    }
}

function requestTranslation(
    messageId: string,
    channelId: string | undefined,
    content: string,
    cacheSignature: string,
    requestSignature: string,
    translationOptions: { ignoreConfidenceRequirement?: boolean; sourceLang?: string; targetLang?: string; },
    showFailureNotice = true,
    replace = false
) {
    const identity: TranslationRequestIdentity = { messageId, channelId, content, cacheSignature, requestSignature };
    const queued = queueTranslationRequest(
        identity,
        signal => translate("received", content, translationOptions, signal),
        {
            onResolve: translated => {
                const current = getCurrentReceivedTranslationState(channelId, !!translationOptions.ignoreConfidenceRequirement);
                if (current.cacheSignature !== cacheSignature || current.requestSignature !== requestSignature) return;

                applyTranslation(messageId, channelId, content, cacheSignature, translated);
            },
            onError: error => {
                const current = getCurrentReceivedTranslationState(channelId, !!translationOptions.ignoreConfidenceRequirement);
                if (current.cacheSignature !== cacheSignature
                    || current.requestSignature !== requestSignature
                    || !isMessageContentCurrent(messageId, channelId, content))
                    return;

                const notice = createFailureNotice(error);
                FailedTranslations.set(messageId, { channelId, content, cacheSignature, requestSignature, notice });
                pruneOldestEntries(FailedTranslations);
                setTranslationNotice(messageId, showFailureNotice ? notice : undefined);
            },
            onSettled: () => TranslationLoadingSetters.get(messageId)?.(false)
        },
        replace
    );

    TranslationLoadingSetters.get(messageId)?.(true);
    if (queued)
        setTranslationNotice(messageId, undefined);
}

export function translateMessageManually(message: Message, content: string) {
    const channelId = getMessageChannelId(message);
    const { cacheSignature, requestSignature, translationOptions } = getCurrentReceivedTranslationState(channelId, true);
    const identity: TranslationRequestIdentity = { messageId: message.id, channelId, content, cacheSignature, requestSignature };
    const queued = queueTranslationRequest(
        identity,
        signal => translate("received", content, { ...translationOptions, ignoreConfidenceRequirement: true }, signal),
        {
            onResolve: translation => {
                const current = getCurrentReceivedTranslationState(channelId, true);
                if (current.cacheSignature !== cacheSignature || current.requestSignature !== requestSignature) return;

                handleManualTranslateResult(message.id, channelId, content, translation, cacheSignature);
            },
            onError: error => {
                const current = getCurrentReceivedTranslationState(channelId, true);
                if (current.cacheSignature === cacheSignature
                    && current.requestSignature === requestSignature
                    && isMessageContentCurrent(message.id, channelId, content))
                    showToast(normalizeTranslationFailureReason(error), Toasts.Type.FAILURE);
            },
            onSettled: () => TranslationLoadingSetters.get(message.id)?.(false)
        }
    );

    if (queued) {
        FailedTranslations.delete(message.id);
        DismissedTranslations.delete(message.id);
        TranslationLoadingSetters.get(message.id)?.(true);
        TranslationNoticeSetters.get(message.id)?.(undefined);
    }
}

export async function clearChannelTranslationCache(channelId: string) {
    await ensurePersistentCacheLoaded();

    deleteCachedTranslations(entry => entry.channelId === channelId, true);

    for (const [messageId, entry] of ManualTranslations.entries()) {
        if (entry.channelId === channelId)
            ManualTranslations.delete(messageId);
    }

    for (const [messageId, entry] of DismissedTranslations.entries()) {
        if (entry.channelId === channelId)
            DismissedTranslations.delete(messageId);
    }

    for (const [messageId, entry] of FailedTranslations.entries()) {
        if (entry.channelId === channelId) {
            FailedTranslations.delete(messageId);
            TranslationNoticeSetters.get(messageId)?.(undefined);
        }
    }

    for (const messageId of cancelTranslationRequests(request => request.channelId === channelId)) {
        TranslationLoadingSetters.get(messageId)?.(false);
        TranslationNoticeSetters.get(messageId)?.(undefined);
    }

    for (const [messageId, entry] of TranslationDisplayStates.entries()) {
        if (entry.channelId === channelId) {
            TranslationDisplayStates.delete(messageId);
            deleteReplacedMessageSourceLanguage(messageId);
        }
    }

    schedulePersistentCacheFlush();
    notifyTranslationCacheStatsChanged();
}

export async function clearTranslationCacheForSignature(cacheSignature: string) {
    await ensurePersistentCacheLoaded();

    let changed = false;
    const affectedMessageIds = new Set<string>();

    for (const messageId of deleteCachedTranslations(entry => entry.cacheSignature === cacheSignature, true)) {
        TranslationNoticeSetters.get(messageId)?.(undefined);
        affectedMessageIds.add(messageId);
        changed = true;
    }

    for (const [messageId, entry] of ManualTranslations.entries()) {
        if (entry.cacheSignature === cacheSignature) {
            ManualTranslations.delete(messageId);
            affectedMessageIds.add(messageId);
            changed = true;
        }
    }

    for (const [messageId, entry] of DismissedTranslations.entries()) {
        if (entry.cacheSignature === cacheSignature) {
            DismissedTranslations.delete(messageId);
            affectedMessageIds.add(messageId);
            changed = true;
        }
    }

    for (const [messageId, entry] of FailedTranslations.entries()) {
        if (entry.cacheSignature === cacheSignature) {
            FailedTranslations.delete(messageId);
            TranslationNoticeSetters.get(messageId)?.(undefined);
            affectedMessageIds.add(messageId);
            changed = true;
        }
    }

    for (const messageId of cancelTranslationRequests(request => request.cacheSignature === cacheSignature)) {
        TranslationLoadingSetters.get(messageId)?.(false);
        TranslationNoticeSetters.get(messageId)?.(undefined);
        affectedMessageIds.add(messageId);
        changed = true;
    }

    for (const messageId of affectedMessageIds) {
        TranslationDisplayStates.delete(messageId);
        deleteReplacedMessageSourceLanguage(messageId);
    }

    if (!changed) return;

    schedulePersistentCacheFlush();
    notifyTranslationCacheStatsChanged();
}

function Dismiss({ onDismiss }: { onDismiss: () => void; }) {
    return (
        <button
            onClick={onDismiss}
            className={cl("dismiss")}
        >
            Dismiss
        </button>
    );
}

function truncateText(text: string, maxLength = 160) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trimEnd()}…`;
}

function isEmbeddedMessage(message: Message) {
    return Boolean((message as Partial<{ vencordEmbeddedBy: unknown; }>).vencordEmbeddedBy);
}

export function TranslationAccessory({ message }: { message: Message; }) {
    const {
        autoTranslateReceived,
        collapseTranslatedMessages,
        replaceMessageContent,
        simpleMode,
        receivedDisplayMode,
        receivedChannelOverrides,
        receivedChannelInputOverrides,
        receivedChannelOutputOverrides,
        service,
        receivedInput,
        receivedOutput,
        deeplApiKey,
        azureApiKey,
        azureRegion,
        azureEndpoint,
        showTranslationFailureReasons,
        autoTranslateMaxCharacters,
        autoTranslateMaxLines,
        googleConfidenceRequirement,
        translationCacheTtlDays,
        skipCodeBlockMessages,
        skipAlreadyTranslatedMessages,
        skipBotMessages,
        ignoredGuilds,
        ignoredChannels,
        ignoredUsers
    } = settings.use(ACCESSORY_SETTING_KEYS);
    const [translation, setTranslation] = useState<TranslationValue>();
    const [isTranslating, setIsTranslating] = useState(false);
    const [notice, setNotice] = useState<TranslationNotice>();
    const [cacheHydrated, setCacheHydrated] = useState(isPersistentCacheLoaded);
    const [cacheHydrationVersion, setCacheHydrationVersion] = useState(0);
    const content = getMessageContent(message);
    const channelId = getMessageChannelId(message);
    const embedded = isEmbeddedMessage(message);
    const currentUserId = UserStore.getCurrentUser()?.id;
    const authorId = message.author?.id;
    const automaticSkipReason = useMemo(
        () => content ? getAutomaticMessageSkipReason(message, content) : null,
        [autoTranslateMaxCharacters, autoTranslateMaxLines, content, ignoredChannels, ignoredGuilds, ignoredUsers, message, skipAlreadyTranslatedMessages, skipBotMessages, skipCodeBlockMessages]
    );
    const isReceivedAutoTranslateEnabled = getReceivedAutoTranslateChannelState(channelId, autoTranslateReceived, receivedChannelOverrides);
    const translationOptions = useMemo(() => getReceivedTranslationOptionsForChannel(
        channelId,
        receivedInput,
        receivedOutput,
        receivedChannelInputOverrides,
        receivedChannelOutputOverrides
    ), [channelId, receivedInput, receivedOutput, receivedChannelInputOverrides, receivedChannelOutputOverrides]);
    const cacheSignature = getReceivedTranslationCacheSignatureFromValues(
        translationOptions.sourceLang,
        translationOptions.targetLang,
        service
    );
    const requestSignature = getReceivedTranslationRequestSignature({
        service: IS_WEB ? "google" : service,
        receivedInput: translationOptions.sourceLang,
        receivedOutput: translationOptions.targetLang,
        deeplApiKey,
        azureApiKey,
        azureRegion,
        azureEndpoint,
        googleConfidenceRequirement
    });
    const requiredGoogleConfidence = Number(googleConfidenceRequirement) || 0;
    const [displayState, setDisplayState] = useState(() => getTranslationDisplayState(message.id, channelId, !!collapseTranslatedMessages, String(receivedDisplayMode || "translated")));

    useEffect(() => {
        if (embedded) return;

        TranslationSetters.set(message.id, setTranslation);
        TranslationLoadingSetters.set(message.id, setIsTranslating);
        TranslationNoticeSetters.set(message.id, setNotice);
        let active = true;
        let unsubscribePersistentCacheLoaded: (() => void) | undefined;

        if (!isPersistentCacheLoaded())
            void ensurePersistentCacheLoaded().then(loaded => {
                if (!active) return;

                setCacheHydrated(true);
                if (!loaded)
                    unsubscribePersistentCacheLoaded = subscribePersistentCacheLoaded(() => {
                        if (active)
                            setCacheHydrationVersion(version => version + 1);
                    });
            });

        return () => {
            active = false;
            unsubscribePersistentCacheLoaded?.();
            cancelTranslationRequest(message.id);
            VisibleMessages.delete(message.id);
            TranslationSetters.delete(message.id);
            TranslationLoadingSetters.delete(message.id);
            TranslationNoticeSetters.delete(message.id);
        };
    }, [embedded, message.id]);

    useEffect(() => {
        if (embedded) return;

        VisibleMessages.set(message.id, message);
        return () => {
            if (VisibleMessages.get(message.id) === message)
                VisibleMessages.delete(message.id);
        };
    }, [embedded, message, message.id]);

    useEffect(() => {
        const nextState = getTranslationDisplayState(message.id, channelId, !!collapseTranslatedMessages, String(receivedDisplayMode || "translated"));
        setDisplayState(nextState);
    }, [channelId, collapseTranslatedMessages, message.id, receivedDisplayMode]);

    useEffect(() => {
        if (embedded) return;

        ensureFreshState(cacheSignature);

        if (!content) {
            setTranslation(undefined);
            setIsTranslating(false);
            setNotice(createSkipNotice({ reason: "Skipped: no translatable text", canTranslateManually: false }));
            return;
        }

        resetMessageTranslationStateIfContentChanged(message.id, content);

        const manualTranslation = ManualTranslations.get(message.id);
        if (manualTranslation?.content === content && manualTranslation.cacheSignature === cacheSignature) {
            const cached = getCachedTranslation(message.id);
            if (cached?.content === content && cached.cacheSignature === cacheSignature) {
                setTranslation(cached.translation);
                setIsTranslating(false);
                setNotice(undefined);
                return;
            }
        } else {
            ManualTranslations.delete(message.id);
        }

        if (!isReceivedAutoTranslateEnabled) {
            setTranslation(undefined);
            setIsTranslating(false);
            setNotice(undefined);
            return;
        }

        if (currentUserId && String(authorId) === String(currentUserId)) {
            setTranslation(undefined);
            setIsTranslating(false);
            setNotice(undefined);
            return;
        }

        const dismissedTranslation = DismissedTranslations.get(message.id);
        if (
            dismissedTranslation?.content === content
            && dismissedTranslation.cacheSignature === cacheSignature
            && dismissedTranslation.channelId === channelId
        ) {
            setTranslation(undefined);
            setIsTranslating(false);
            setNotice(undefined);
            return;
        }

        const skipReason = automaticSkipReason;
        if (skipReason) {
            setTranslation(undefined);
            setIsTranslating(false);
            setNotice(showTranslationFailureReasons || !skipReason.canTranslateManually ? createSkipNotice(skipReason) : undefined);
            return;
        }

        const cached = getCachedTranslation(message.id);
        if (cached?.content === content && cached.cacheSignature === cacheSignature) {
            const lowConfidenceNotice = getLowConfidenceNotice(cached.translation, service, requiredGoogleConfidence);
            if (lowConfidenceNotice) {
                setTranslation(undefined);
                setIsTranslating(false);
                setNotice(showTranslationFailureReasons ? lowConfidenceNotice : undefined);
                return;
            }

            touchCachedTranslation(message.id);
            setTranslation(cached.translation);
            setIsTranslating(false);
            setNotice(undefined);
            return;
        }

        setTranslation(undefined);
        setNotice(undefined);

        if (!cacheHydrated) {
            setIsTranslating(false);
            return;
        }

        const failedTranslation = FailedTranslations.get(message.id);
        if (
            failedTranslation?.content === content
            && failedTranslation.cacheSignature === cacheSignature
            && failedTranslation.requestSignature === requestSignature
            && failedTranslation.channelId === channelId
        ) {
            setIsTranslating(false);
            setNotice(showTranslationFailureReasons ? failedTranslation.notice : undefined);
            return;
        }
        const requestIdentity: TranslationRequestIdentity = { messageId: message.id, channelId, content, cacheSignature, requestSignature };
        if (isTranslationRequestPending(requestIdentity)) {
            setIsTranslating(true);
            return () => {
                cancelTranslationRequest(message.id);
            };
        }

        requestTranslation(message.id, channelId, content, cacheSignature, requestSignature, translationOptions, showTranslationFailureReasons);

        return () => {
            cancelTranslationRequest(message.id);
        };
    }, [authorId, automaticSkipReason?.canTranslateManually, automaticSkipReason?.reason, cacheHydrated, cacheHydrationVersion, cacheSignature, channelId, content, currentUserId, embedded, isReceivedAutoTranslateEnabled, message.id, requestSignature, requiredGoogleConfidence, service, showTranslationFailureReasons, translationCacheTtlDays, translationOptions]);

    if (!translation && !isTranslating && !notice) return null;

    const effectiveDisplayMode = simpleMode ? "translated" : receivedDisplayMode;
    const isCompactDisplay = effectiveDisplayMode === "compact";
    const displayedView = effectiveDisplayMode === "toggle" ? displayState.view : "translation";
    const translationText = translation?.text ?? "";
    const originalText = content;
    const displayedText = displayedView === "original" ? originalText : translationText;
    const collapsedText = truncateText(displayedText);
    const showExpandedContent = displayState.expanded;
    const shouldShowTranslationBody = !replaceMessageContent && (!isCompactDisplay || showExpandedContent);
    const shouldShowFullActions = !replaceMessageContent && !simpleMode && (!isCompactDisplay || showExpandedContent);
    const isCompactCollapsed = isCompactDisplay && !showExpandedContent && !!translation && !notice;

    if (replaceMessageContent && translation && !isTranslating && !notice)
        return null;

    if (!translation && !isTranslating && notice?.quiet) {
        return (
            <span className={cl("skip-note")}>
                {notice.message}
            </span>
        );
    }

    return (
        <span
            className={cl("accessory", isCompactCollapsed ? "accessory-compact" : undefined, notice?.kind === "failure" ? "accessory-error" : undefined)}
            title={isCompactCollapsed ? translationText : undefined}
        >
            <TranslateIcon width={16} height={16} className={cl("accessory-icon")} />
            {isTranslating && !translation && !notice && "Translating..."}
            {!isTranslating && notice && (
                <>
                    {notice.message}
                    <br />
                    (
                    {notice.canTranslateManually && (
                        <>
                            <button
                                onClick={() => {
                                    if (isTranslating) return;

                                    DismissedTranslations.delete(message.id);
                                    FailedTranslations.delete(message.id);
                                    setIsTranslating(true);
                                    setNotice(undefined);
                                    const manualRequest = getCurrentReceivedTranslationState(channelId, true);
                                    requestTranslation(message.id, channelId, content, manualRequest.cacheSignature, manualRequest.requestSignature, {
                                        ...manualRequest.translationOptions,
                                        ignoreConfidenceRequirement: true
                                    }, true, true);
                                }}
                                className={cl("dismiss")}
                                disabled={isTranslating}
                            >
                                {notice.kind === "skip" ? "Translate Anyway" : "Retry"}
                            </button>
                            {" - "}
                        </>
                    )}
                    <Dismiss onDismiss={() => {
                        DismissedTranslations.set(message.id, { channelId, content, cacheSignature });
                        ManualTranslations.delete(message.id);
                        pruneOldestEntries(DismissedTranslations);
                        setIsTranslating(false);
                        setTranslation(undefined);
                        setNotice(undefined);
                    }} />
                    )
                </>
            )}
            {translation && (
                <>
                    {shouldShowTranslationBody && (
                        <>
                            {showExpandedContent ? (
                                <>
                                    {Parser.parse(displayedText)}
                                </>
                            ) : Parser.parse(collapsedText)}
                            <br />
                        </>
                    )}
                    {isCompactCollapsed ? (
                        <>
                            <span className={cl("compact-label")}>Translated</span>
                            {" · "}
                            <button
                                onClick={() => {
                                    const nextState = {
                                        ...displayState,
                                        expanded: !displayState.expanded
                                    };
                                    setDisplayState(nextState);
                                    setTranslationDisplayState(message.id, { ...nextState, channelId });
                                }}
                                className={cl("dismiss")}
                            >
                                Expand
                            </button>
                        </>
                    ) : !simpleMode && (
                        <>
                            {effectiveDisplayMode === "dual" && (
                                <>
                                    <span className={cl("secondary-text")}>
                                        Original: {Parser.parse(originalText)}
                                    </span>
                                    <br />
                                </>
                            )}
                            (
                            <button
                                onClick={() => {
                                    const nextState = {
                                        ...displayState,
                                        expanded: !displayState.expanded
                                    };
                                    setDisplayState(nextState);
                                    setTranslationDisplayState(message.id, { ...nextState, channelId });
                                }}
                                className={cl("dismiss")}
                            >
                                {displayState.expanded ? "Collapse" : "Expand"}
                            </button>
                            {shouldShowFullActions && effectiveDisplayMode === "toggle" && displayState.expanded && (
                                <>
                                    {" - "}
                                    <button
                                        onClick={() => {
                                            const nextState: TranslationDisplayState = {
                                                ...displayState,
                                                view: displayState.view === "translation" ? "original" : "translation"
                                            };
                                            setDisplayState(nextState);
                                            setTranslationDisplayState(message.id, { ...nextState, channelId });
                                        }}
                                        className={cl("dismiss")}
                                    >
                                        {displayState.view === "translation" ? "Show Original" : "Show Translation"}
                                    </button>
                                </>
                            )}
                            {shouldShowFullActions && (
                                <>
                                    {" - "}
                                    <button
                                        onClick={() => {
                                            if (isTranslating) return;

                                            const cached = getCachedTranslation(message.id);
                                            if (cached)
                                                touchCachedTranslation(message.id);
                                            DismissedTranslations.delete(message.id);
                                            FailedTranslations.delete(message.id);
                                            setIsTranslating(true);
                                            const manualRequest = getCurrentReceivedTranslationState(channelId, true);
                                            requestTranslation(message.id, channelId, content, manualRequest.cacheSignature, manualRequest.requestSignature, {
                                                ...manualRequest.translationOptions,
                                                ignoreConfidenceRequirement: true
                                            }, true, true);
                                        }}
                                        className={cl("dismiss")}
                                        disabled={isTranslating}
                                    >
                                        {isTranslating ? "Retranslating..." : "Retranslate"}
                                    </button>
                                    {" - "}
                                    <Dismiss onDismiss={() => {
                                        DismissedTranslations.set(message.id, { channelId, content, cacheSignature });
                                        ManualTranslations.delete(message.id);
                                        pruneOldestEntries(DismissedTranslations);
                                        setIsTranslating(false);
                                        setTranslation(undefined);
                                        setNotice(undefined);
                                    }} />
                                </>
                            )}
                            )
                        </>
                    )}
                </>
            )}
        </span>
    );
}
