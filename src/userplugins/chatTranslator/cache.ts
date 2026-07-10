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

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";

import { settings } from "./settings";
import type { TranslationValue } from "./utils";

export interface CachedTranslation {
    channelId?: string;
    content: string;
    cacheSignature: string;
    translation: TranslationValue;
    updatedAt: number;
}

interface PersistedTranslation extends CachedTranslation {
    messageId: string;
}

const MAX_TRANSLATION_ENTRIES = 1500;
const PERSISTENT_CACHE_KEY = "receivedTranslations";
const PERSISTENT_CACHE_FLUSH_DELAY_MS = 300;
const PERSISTENT_CACHE_RETRY_DELAY_MS = 10_000;
const MAX_PERSISTENT_CACHE_RETRY_DELAY_MS = 5 * 60_000;
const MAX_CACHE_PRUNE_TIMEOUT_MS = 2_147_483_647;

const CacheLogger = new Logger("ChatTranslatorCache");
const TranslationCache = new Map<string, CachedTranslation>();
const TranslatedSourceLanguages = new Map<string, string>();
const CacheStatsVersionListeners = new Set<(v: number) => void>();
const VisibleCacheDeleteListeners = new Set<(messageId: string) => void>();
const PersistentCacheLoadedListeners = new Set<() => void>();
const ChatTranslatorStore = DataStore.createStore("ChatTranslatorData", "ChatTranslatorStore");
let activeCacheSignature = "";
let cacheStatsVersion = 0;
let cacheActive = false;
let persistentCacheLoaded = false;
let persistentCacheLoadPromise: Promise<boolean> | null = null;
let persistentCacheWriteQueue = Promise.resolve();
let persistentCacheFlushTimeout: ReturnType<typeof setTimeout> | null = null;
let persistentCacheRetryTimeout: ReturnType<typeof setTimeout> | null = null;
let expiredCachePruneTimeout: ReturnType<typeof setTimeout> | null = null;
let scheduledCacheExpiryAt = Infinity;
let persistentCacheGeneration = 0;
let nextPersistentCacheLoadAttemptAt = 0;
let persistentCacheRetryDelayMs = PERSISTENT_CACHE_RETRY_DELAY_MS;

export function pruneOldestEntries<T>(map: Map<string, T>) {
    while (map.size > MAX_TRANSLATION_ENTRIES) {
        const oldest = map.keys().next();
        if (oldest.done) return;

        map.delete(oldest.value);
    }
}

function pruneOldestCachedTranslations() {
    let changed = false;

    while (TranslationCache.size > MAX_TRANSLATION_ENTRIES) {
        const oldest = TranslationCache.keys().next();
        if (oldest.done) break;

        const messageId = oldest.value;
        TranslationCache.delete(messageId);
        TranslatedSourceLanguages.delete(messageId);
        notifyVisibleCacheDelete(messageId);
        changed = true;
    }

    return changed;
}

export function getTranslationCacheTtlMs() {
    const ttlDays = Number(settings.store.translationCacheTtlDays) || 0;
    return ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : 0;
}

function isTranslationCacheEntryExpired(entry: CachedTranslation | PersistedTranslation, now = Date.now()) {
    const ttlMs = getTranslationCacheTtlMs();
    return ttlMs > 0 && now - entry.updatedAt > ttlMs;
}

function notifyCacheStatsVersion() {
    cacheStatsVersion++;
    for (const listener of CacheStatsVersionListeners) {
        try {
            listener(cacheStatsVersion);
        } catch (error) {
            CacheLogger.error("Translation cache stats listener failed", error);
        }
    }
}

export function notifyTranslationCacheStatsChanged() {
    notifyCacheStatsVersion();
}

function notifyVisibleCacheDelete(messageId: string) {
    for (const listener of VisibleCacheDeleteListeners) {
        try {
            listener(messageId);
        } catch (error) {
            CacheLogger.error("Visible translation cache listener failed", error);
        }
    }
}

function notifyPersistentCacheLoaded() {
    const listeners = Array.from(PersistentCacheLoadedListeners);
    PersistentCacheLoadedListeners.clear();

    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            CacheLogger.error("Translation cache load listener failed", error);
        }
    }
}

function serializeTranslationCache(now = Date.now()) {
    const persistedTranslations: PersistedTranslation[] = [];

    for (const [messageId, value] of TranslationCache.entries()) {
        if (isTranslationCacheEntryExpired(value, now)) continue;

        persistedTranslations.push({
            messageId,
            channelId: value.channelId,
            content: value.content,
            cacheSignature: value.cacheSignature,
            translation: value.translation,
            updatedAt: value.updatedAt
        });
    }

    return persistedTranslations;
}

function persistSerializedTranslations(persistedTranslations: PersistedTranslation[], generation = persistentCacheGeneration) {
    const write = persistentCacheWriteQueue.then(() => {
        if (generation !== persistentCacheGeneration) return;
        return DataStore.set(PERSISTENT_CACHE_KEY, persistedTranslations, ChatTranslatorStore);
    });

    persistentCacheWriteQueue = write.catch(logCacheWriteError);
    return write;
}

function persistCurrentTranslationCache(generation = persistentCacheGeneration) {
    if (generation !== persistentCacheGeneration) return Promise.resolve();
    return persistSerializedTranslations(serializeTranslationCache(), generation);
}

function logCacheWriteError(error: unknown) {
    CacheLogger.error("Failed to save translation cache", error);
}

function scheduleExpiredCachePrune(candidateExpiryAt?: number) {
    const ttlMs = getTranslationCacheTtlMs();
    if (!ttlMs || !TranslationCache.size) {
        clearExpiredCachePruneTimeout();
        return;
    }

    const now = Date.now();
    let nextExpiryAt = candidateExpiryAt ?? Infinity;

    if (candidateExpiryAt == null)
        for (const entry of TranslationCache.values())
            nextExpiryAt = Math.min(nextExpiryAt, entry.updatedAt + ttlMs);

    if (!Number.isFinite(nextExpiryAt)) return;
    if (expiredCachePruneTimeout && scheduledCacheExpiryAt <= nextExpiryAt) return;

    clearExpiredCachePruneTimeout();

    const delay = Math.min(
        MAX_CACHE_PRUNE_TIMEOUT_MS,
        Math.max(1_000, nextExpiryAt - now)
    );

    scheduledCacheExpiryAt = nextExpiryAt;
    expiredCachePruneTimeout = setTimeout(() => {
        expiredCachePruneTimeout = null;
        scheduledCacheExpiryAt = Infinity;
        pruneExpiredTranslationCache();
    }, delay);
}

function clearPersistentCacheFlushTimeout() {
    if (!persistentCacheFlushTimeout) return;

    clearTimeout(persistentCacheFlushTimeout);
    persistentCacheFlushTimeout = null;
}

function clearPersistentCacheRetryTimeout() {
    if (!persistentCacheRetryTimeout) return;

    clearTimeout(persistentCacheRetryTimeout);
    persistentCacheRetryTimeout = null;
}

function clearExpiredCachePruneTimeout() {
    if (!expiredCachePruneTimeout) return;

    clearTimeout(expiredCachePruneTimeout);
    expiredCachePruneTimeout = null;
    scheduledCacheExpiryAt = Infinity;
}

export function isPersistentCacheLoaded() {
    return persistentCacheLoaded;
}

export function getTranslationCacheStatsVersion() {
    return cacheStatsVersion;
}

export function subscribeTranslationCacheStatsVersion(listener: (version: number) => void) {
    CacheStatsVersionListeners.add(listener);
    return () => {
        CacheStatsVersionListeners.delete(listener);
    };
}

export function subscribeVisibleCacheDeletes(listener: (messageId: string) => void) {
    VisibleCacheDeleteListeners.add(listener);
    return () => {
        VisibleCacheDeleteListeners.delete(listener);
    };
}

export function subscribePersistentCacheLoaded(listener: () => void) {
    if (persistentCacheLoaded) {
        try {
            listener();
        } catch (error) {
            CacheLogger.error("Translation cache load listener failed", error);
        }
        return () => undefined;
    }

    PersistentCacheLoadedListeners.add(listener);
    return () => {
        PersistentCacheLoadedListeners.delete(listener);
    };
}

export function setActiveCacheSignature(cacheSignature: string) {
    activeCacheSignature = cacheSignature;
}

export function getReplacedMessageSourceLanguage(messageId: string) {
    return TranslatedSourceLanguages.get(messageId);
}

export function deleteReplacedMessageSourceLanguage(messageId: string) {
    TranslatedSourceLanguages.delete(messageId);
}

export function setReplacedMessageSourceLanguage(messageId: string, sourceLanguage: string) {
    TranslatedSourceLanguages.set(messageId, sourceLanguage);
}

export function peekCachedTranslation(messageId: string) {
    return TranslationCache.get(messageId);
}

export function setCachedTranslation(
    messageId: string,
    channelId: string | undefined,
    content: string,
    cacheSignature: string,
    translation: TranslationValue,
    updatedAt = Date.now()
) {
    TranslationCache.delete(messageId);
    TranslationCache.set(messageId, { channelId, content, cacheSignature, translation, updatedAt });
    pruneOldestCachedTranslations();

    const ttlMs = getTranslationCacheTtlMs();
    scheduleExpiredCachePrune(ttlMs ? updatedAt + ttlMs : undefined);
}

export function touchCachedTranslation(messageId: string) {
    const cached = TranslationCache.get(messageId);
    if (!cached) return false;

    TranslationCache.delete(messageId);
    TranslationCache.set(messageId, cached);
    return true;
}

export function deleteCachedTranslation(messageId: string, updateVisibleState = false) {
    TranslatedSourceLanguages.delete(messageId);
    const wasDeleted = TranslationCache.delete(messageId);
    if (!wasDeleted) return false;

    if (updateVisibleState)
        notifyVisibleCacheDelete(messageId);

    return true;
}

export function deleteCachedTranslations(
    predicate: (entry: CachedTranslation, messageId: string) => boolean,
    updateVisibleState = false
) {
    const deletedMessageIds: string[] = [];

    for (const [messageId, entry] of TranslationCache.entries()) {
        if (!predicate(entry, messageId)) continue;
        if (!deleteCachedTranslation(messageId, updateVisibleState)) continue;

        deletedMessageIds.push(messageId);
    }

    if (deletedMessageIds.length)
        scheduleExpiredCachePrune();

    return deletedMessageIds;
}

export function pruneExpiredTranslationCache() {
    let changed = false;

    for (const [messageId, entry] of TranslationCache.entries()) {
        if (!isTranslationCacheEntryExpired(entry)) continue;

        deleteCachedTranslation(messageId, true);
        changed = true;
    }

    scheduleExpiredCachePrune();

    if (!changed) return false;

    schedulePersistentCacheFlush();
    notifyCacheStatsVersion();
    return true;
}

export function getCachedTranslation(messageId: string) {
    const cached = TranslationCache.get(messageId);
    if (!cached) return undefined;

    if (!isTranslationCacheEntryExpired(cached))
        return cached;

    deleteCachedTranslation(messageId, true);
    schedulePersistentCacheFlush();
    notifyCacheStatsVersion();
    return undefined;
}

export function getCachedTranslationForRender(messageId: string) {
    const cached = TranslationCache.get(messageId);
    return cached && !isTranslationCacheEntryExpired(cached) ? cached : undefined;
}

function isPersistedTranslation(value: unknown): value is PersistedTranslation {
    if (!isObject(value) || !("translation" in value) || !isObject(value.translation))
        return false;

    return "messageId" in value
        && typeof value.messageId === "string"
        && (!("channelId" in value) || value.channelId == null || typeof value.channelId === "string")
        && "content" in value
        && typeof value.content === "string"
        && "cacheSignature" in value
        && typeof value.cacheSignature === "string"
        && value.cacheSignature.startsWith("v2::")
        && "updatedAt" in value
        && typeof value.updatedAt === "number"
        && Number.isFinite(value.updatedAt)
        && "text" in value.translation
        && typeof value.translation.text === "string"
        && "sourceLanguage" in value.translation
        && typeof value.translation.sourceLanguage === "string"
        && (!("confidence" in value.translation)
            || value.translation.confidence == null
            || (typeof value.translation.confidence === "number" && Number.isFinite(value.translation.confidence)));
}

async function loadPersistentCache(generation: number) {
    await persistentCacheWriteQueue;
    const storedTranslations = await DataStore.get<unknown>(PERSISTENT_CACHE_KEY, ChatTranslatorStore);
    if (generation !== persistentCacheGeneration) return;

    const persistedTranslations = Array.isArray(storedTranslations) ? storedTranslations : [];
    let droppedEntries = storedTranslations != null && !Array.isArray(storedTranslations);

    for (const entry of persistedTranslations) {
        if (!isPersistedTranslation(entry) || isTranslationCacheEntryExpired(entry)) {
            droppedEntries = true;
            continue;
        }

        const existing = TranslationCache.get(entry.messageId);
        if (existing && existing.updatedAt >= entry.updatedAt) continue;

        TranslationCache.delete(entry.messageId);
        TranslationCache.set(entry.messageId, {
            channelId: entry.channelId,
            content: entry.content,
            cacheSignature: entry.cacheSignature,
            translation: entry.translation,
            updatedAt: entry.updatedAt
        });
    }

    droppedEntries = pruneOldestCachedTranslations() || droppedEntries;
    scheduleExpiredCachePrune();

    if (droppedEntries)
        void persistCurrentTranslationCache(generation);
}

export function ensurePersistentCacheLoaded() {
    if (!cacheActive) return Promise.resolve(false);
    if (persistentCacheLoaded) return Promise.resolve(true);
    if (persistentCacheLoadPromise) return persistentCacheLoadPromise;
    if (Date.now() < nextPersistentCacheLoadAttemptAt) return Promise.resolve(false);

    const generation = persistentCacheGeneration;
    const loadPromise = loadPersistentCache(generation)
        .then(() => {
            if (generation !== persistentCacheGeneration) return false;

            persistentCacheLoaded = true;
            nextPersistentCacheLoadAttemptAt = 0;
            persistentCacheRetryDelayMs = PERSISTENT_CACHE_RETRY_DELAY_MS;
            clearPersistentCacheRetryTimeout();
            notifyCacheStatsVersion();
            notifyPersistentCacheLoaded();
            return true;
        })
        .catch(error => {
            CacheLogger.error("Failed to load translation cache", error);
            if (generation === persistentCacheGeneration)
                schedulePersistentCacheRetry();

            return false;
        })
        .finally(() => {
            if (persistentCacheLoadPromise === loadPromise)
                persistentCacheLoadPromise = null;
        });

    persistentCacheLoadPromise = loadPromise;
    return loadPromise;
}

function schedulePersistentCacheRetry() {
    if (!cacheActive || persistentCacheRetryTimeout) return;

    const delay = persistentCacheRetryDelayMs;
    nextPersistentCacheLoadAttemptAt = Date.now() + delay;
    persistentCacheRetryDelayMs = Math.min(delay * 2, MAX_PERSISTENT_CACHE_RETRY_DELAY_MS);
    persistentCacheRetryTimeout = setTimeout(() => {
        persistentCacheRetryTimeout = null;
        nextPersistentCacheLoadAttemptAt = 0;
        void ensurePersistentCacheLoaded().then(loaded => {
            if (loaded)
                schedulePersistentCacheFlush();
        });
    }, delay);
}

export function schedulePersistentCacheFlush() {
    if (!cacheActive) return;
    if (!persistentCacheLoaded) {
        void ensurePersistentCacheLoaded().then(loaded => {
            if (cacheActive && loaded)
                schedulePersistentCacheFlush();
        });
        return;
    }

    clearPersistentCacheFlushTimeout();

    const generation = persistentCacheGeneration;
    persistentCacheFlushTimeout = setTimeout(() => {
        persistentCacheFlushTimeout = null;
        void persistCurrentTranslationCache(generation);
    }, PERSISTENT_CACHE_FLUSH_DELAY_MS);
}

export function startTranslationCache() {
    if (cacheActive) return;

    cacheActive = true;
    void ensurePersistentCacheLoaded();
}

export function stopTranslationCache() {
    if (!cacheActive) return;

    cacheActive = false;
    clearPersistentCacheFlushTimeout();
    clearPersistentCacheRetryTimeout();
    clearExpiredCachePruneTimeout();

    const shouldPersist = persistentCacheLoaded;
    const persistedTranslations = shouldPersist ? serializeTranslationCache() : [];
    const generation = ++persistentCacheGeneration;

    persistentCacheLoaded = false;
    persistentCacheLoadPromise = null;
    nextPersistentCacheLoadAttemptAt = 0;
    persistentCacheRetryDelayMs = PERSISTENT_CACHE_RETRY_DELAY_MS;
    activeCacheSignature = "";
    TranslationCache.clear();
    TranslatedSourceLanguages.clear();
    CacheStatsVersionListeners.clear();
    VisibleCacheDeleteListeners.clear();
    PersistentCacheLoadedListeners.clear();

    if (shouldPersist)
        void persistSerializedTranslations(persistedTranslations, generation);
}

export async function clearPersistentTranslationCache() {
    const generation = ++persistentCacheGeneration;
    const deletedMessageIds = Array.from(TranslationCache.keys());
    persistentCacheLoaded = true;
    persistentCacheLoadPromise = null;
    nextPersistentCacheLoadAttemptAt = 0;
    persistentCacheRetryDelayMs = PERSISTENT_CACHE_RETRY_DELAY_MS;
    TranslationCache.clear();
    TranslatedSourceLanguages.clear();
    clearPersistentCacheFlushTimeout();
    clearPersistentCacheRetryTimeout();
    clearExpiredCachePruneTimeout();

    for (const messageId of deletedMessageIds)
        notifyVisibleCacheDelete(messageId);

    notifyPersistentCacheLoaded();
    await persistSerializedTranslations([], generation);

    notifyCacheStatsVersion();
}

export function getTranslationCacheStats(cacheSignature: string) {
    let count = 0;
    let matchingEntries = 0;
    let expiredEntries = 0;
    let lastUpdatedAt = 0;
    let oldestUpdatedAt = Infinity;
    let nextExpiresAt = Infinity;
    const now = Date.now();
    const ttlMs = getTranslationCacheTtlMs();

    for (const entry of TranslationCache.values()) {
        if (isTranslationCacheEntryExpired(entry, now)) {
            expiredEntries++;
            continue;
        }

        count++;

        if (entry.cacheSignature === cacheSignature)
            matchingEntries++;

        if (entry.updatedAt > lastUpdatedAt)
            lastUpdatedAt = entry.updatedAt;

        if (entry.updatedAt < oldestUpdatedAt)
            oldestUpdatedAt = entry.updatedAt;

        if (ttlMs)
            nextExpiresAt = Math.min(nextExpiresAt, entry.updatedAt + ttlMs);
    }

    return {
        count,
        matchingEntries,
        expiredEntries,
        lastUpdatedAt: lastUpdatedAt || null,
        oldestUpdatedAt: Number.isFinite(oldestUpdatedAt) ? oldestUpdatedAt : null,
        nextExpiresAt: Number.isFinite(nextExpiresAt) ? nextExpiresAt : null,
        cacheSignature,
        activeCacheSignature
    };
}
