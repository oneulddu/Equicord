/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

export interface TranslationRequestIdentity {
    cacheSignature: string;
    channelId?: string;
    content: string;
    messageId: string;
    requestSignature: string;
}

interface PendingTranslation extends TranslationRequestIdentity {
    controller: AbortController;
    requestId: number;
}

interface TranslationRequestCallbacks<T> {
    onError: (error: unknown) => void;
    onResolve: (value: T) => void;
    onSettled: () => void;
}

interface QueuedTranslation {
    cancel: () => void;
    start: () => void;
}

const MAX_CONCURRENT_TRANSLATIONS = 4;
const RequestLogger = new Logger("ChatTranslatorRequests");
const PendingTranslations = new Map<string, PendingTranslation>();
const LimitedTranslationQueue: QueuedTranslation[] = [];
let activeTranslationCount = 0;
let nextRequestId = 0;

export function createTranslationCacheSignature(service: string | undefined, sourceLanguage: string | undefined, targetLanguage: string | undefined) {
    return ["v2", service ?? "google", sourceLanguage ?? "", targetLanguage ?? ""].join("::");
}

export function containsCodeFence(text: string) {
    return text.includes("```");
}

export function isAbortError(error: unknown) {
    return typeof error === "object"
        && error !== null
        && "name" in error
        && error.name === "AbortError";
}

export function isSameTranslationRequest(left: TranslationRequestIdentity, right: TranslationRequestIdentity) {
    return left.messageId === right.messageId
        && left.channelId === right.channelId
        && left.content === right.content
        && left.cacheSignature === right.cacheSignature
        && left.requestSignature === right.requestSignature;
}

function callSafely(callback: () => void) {
    try {
        callback();
    } catch (error) {
        RequestLogger.error("Translation request callback failed", error);
    }
}

function isCurrentRequest(pending: PendingTranslation) {
    return PendingTranslations.get(pending.messageId)?.requestId === pending.requestId;
}

export function isTranslationRequestPending(identity: TranslationRequestIdentity) {
    const pending = PendingTranslations.get(identity.messageId);
    return pending ? isSameTranslationRequest(pending, identity) : false;
}

function drainLimitedTranslationQueue() {
    while (activeTranslationCount < MAX_CONCURRENT_TRANSLATIONS) {
        const queued = LimitedTranslationQueue.shift();
        if (!queued) return;

        queued.start();
    }
}

function clearLimitedTranslationQueue() {
    const queuedTranslations = LimitedTranslationQueue.splice(0);
    for (const queued of queuedTranslations)
        queued.cancel();
}

export function runLimitedTranslation<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason ?? AbortSignal.abort().reason);
            return;
        }

        let started = false;
        const removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
        const rejectAsAborted = () => reject(signal.reason ?? AbortSignal.abort().reason);
        const handleAbort = () => {
            if (started) return;

            const queueIndex = LimitedTranslationQueue.indexOf(queued);
            if (queueIndex === -1) return;

            LimitedTranslationQueue.splice(queueIndex, 1);
            removeAbortListener();
            rejectAsAborted();
            drainLimitedTranslationQueue();
        };
        const queued: QueuedTranslation = {
            cancel: () => {
                if (started) return;

                removeAbortListener();
                rejectAsAborted();
            },
            start: () => {
                if (started) return;

                started = true;
                removeAbortListener();
                activeTranslationCount++;

                void (async () => {
                    try {
                        signal.throwIfAborted();
                        resolve(await task(signal));
                    } catch (error) {
                        reject(error);
                    } finally {
                        activeTranslationCount--;
                        drainLimitedTranslationQueue();
                    }
                })();
            }
        };

        signal.addEventListener("abort", handleAbort, { once: true });
        LimitedTranslationQueue.push(queued);
        drainLimitedTranslationQueue();
    });
}

export function queueTranslationRequest<T>(
    identity: TranslationRequestIdentity,
    task: (signal: AbortSignal) => Promise<T>,
    callbacks: TranslationRequestCallbacks<T>,
    replace = false
) {
    const existing = PendingTranslations.get(identity.messageId);
    if (!replace && existing && isSameTranslationRequest(existing, identity))
        return false;

    cancelTranslationRequest(identity.messageId);

    const pending: PendingTranslation = {
        ...identity,
        controller: new AbortController(),
        requestId: ++nextRequestId
    };
    PendingTranslations.set(identity.messageId, pending);

    void runLimitedTranslation(pending.controller.signal, task)
        .then(
            value => {
                if (isCurrentRequest(pending))
                    callSafely(() => callbacks.onResolve(value));
            },
            error => {
                if (isCurrentRequest(pending) && !isAbortError(error))
                    callSafely(() => callbacks.onError(error));
            }
        )
        .finally(() => {
            if (!isCurrentRequest(pending)) return;

            PendingTranslations.delete(pending.messageId);
            callSafely(callbacks.onSettled);
        });

    return true;
}

export function cancelTranslationRequest(messageId: string) {
    const pending = PendingTranslations.get(messageId);
    if (!pending) return false;

    PendingTranslations.delete(messageId);
    pending.controller.abort();
    return true;
}

export function cancelTranslationRequests(predicate: (request: TranslationRequestIdentity) => boolean) {
    const cancelledMessageIds: string[] = [];

    for (const [messageId, pending] of PendingTranslations) {
        if (!predicate(pending)) continue;

        cancelTranslationRequest(messageId);
        cancelledMessageIds.push(messageId);
    }

    return cancelledMessageIds;
}

export function clearTranslationRequests(clearQueue = false) {
    for (const pending of PendingTranslations.values())
        pending.controller.abort();

    PendingTranslations.clear();
    if (clearQueue)
        clearLimitedTranslationQueue();
}
