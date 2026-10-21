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

import { classNameFactory } from "@utils/css";
import { isObject } from "@utils/misc";
import { onlyOnce } from "@utils/onlyOnce";
import { PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, showToast, Toasts } from "@webpack/common";

import {
    normalizeLanguageForService,
    parseReceivedChannelLanguageOverrides,
    parseReceivedChannelOverrides,
    ReceivedChannelLanguageOverrideMap,
    ReceivedChannelLanguageOverrideSetting,
    ReceivedChannelOverrideMap,
    serializeReceivedChannelLanguageOverrides,
    serializeReceivedChannelOverrides
} from "./languageOverrides";
import { DeeplLanguages, deeplLanguageToGoogleLanguage, GoogleLanguages } from "./languages";
import { resetLanguageDefaults, settings } from "./settings";
import { containsCodeFence, createTranslationCacheSignature, isAbortError, runLimitedTranslation } from "./translationState";

export const cl = classNameFactory("vc-chat-trans-");

export function getLanguageDisplayName(language: string | undefined) {
    if (!language) return "Unknown";

    const normalized = language.trim();
    if (!normalized) return "Unknown";

    const lower = normalized.toLowerCase();
    const googleLanguage = deeplLanguageToGoogleLanguage(lower);

    return (
        GoogleLanguages[normalized as keyof typeof GoogleLanguages]
        ?? GoogleLanguages[lower as keyof typeof GoogleLanguages]
        ?? GoogleLanguages[googleLanguage as keyof typeof GoogleLanguages]
        ?? DeeplLanguages[normalized as keyof typeof DeeplLanguages]
        ?? DeeplLanguages[lower as keyof typeof DeeplLanguages]
        ?? normalized
    );
}

const Native = VencordNative.pluginHelpers.ChatTranslator as PluginNative<typeof import("./native")>;

export interface AzureConnectionResult {
    sourceLanguage: string;
    text: string;
}

export interface TranslationValue {
    confidence?: number;
    sourceLanguage: string;
    text: string;
}

export interface DeeplUsageResult {
    characterCount: number;
    characterLimit: number;
    apiKeyCharacterCount?: number;
    apiKeyCharacterLimit?: number;
    startTime?: string;
    endTime?: string;
}

export interface ReceivedTranslationOptions {
    ignoreConfidenceRequirement?: boolean;
    sourceLang?: string;
    targetLang?: string;
}

export interface TranslationSkipResult {
    reason: string;
    canTranslateManually: boolean;
}

interface PreservedTextState {
    hasMeaningfulText: boolean;
    restore: (text: string) => string;
    text: string;
}

export const getLanguages = () => IS_WEB || settings.store.service === "google" || settings.store.service === "azure"
    ? GoogleLanguages
    : DeeplLanguages;

const ERROR_TOAST_COOLDOWN_MS = 5000;
const NETWORK_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRANSLATION_RESPONSE_LENGTH = 1_000_000;
const recentErrorToasts = new Map<string, number>();
const IgnoredIdListCache = new Map<"channels" | "guilds" | "users", { raw: string; value: Set<string>; }>();
const StandaloneTranslationControllers = new Set<AbortController>();
let nextNativeRequestId = 0;
const PRESERVED_TOKEN_PATTERN = /⟪MAT_TOKEN_(\d+)⟫/g;
const PRESERVED_SEGMENT_PATTERNS = [
    /```[\s\S]*?(?:```|$)/g,
    /`[^`\n]+`/g,
    /https?:\/\/\S+/g,
    /<a?:[A-Za-z0-9_~]+:\d+>/g,
    /<@[!&]?\d+>/g,
    /<#\d+>/g,
    /<\/[^:>]+:\d+>/g,
    /<t:\d+(?::[tTdDfFR])?>/g,
] as const;

function showDedupedErrorToast(message: string) {
    const now = Date.now();
    const lastShown = recentErrorToasts.get(message) ?? 0;

    if ((now - lastShown) < ERROR_TOAST_COOLDOWN_MS)
        return;

    recentErrorToasts.set(message, now);

    for (const [key, timestamp] of recentErrorToasts) {
        if ((now - timestamp) >= ERROR_TOAST_COOLDOWN_MS)
            recentErrorToasts.delete(key);
    }

    showToast(message, Toasts.Type.FAILURE);
}

export function clearTranslationUtilityCaches() {
    recentErrorToasts.clear();
    IgnoredIdListCache.clear();
}

export function stopStandaloneTranslationRequests() {
    for (const controller of StandaloneTranslationControllers)
        controller.abort();

    StandaloneTranslationControllers.clear();
}

export function getMessageContent(message: Message) {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription || "";
}

function prepareTextForTranslation(text: string): PreservedTextState {
    const preservedValues: string[] = [];
    let masked = text;

    for (const pattern of PRESERVED_SEGMENT_PATTERNS) {
        masked = masked.replace(pattern, match => {
            const token = `⟪MAT_TOKEN_${preservedValues.length}⟫`;
            preservedValues.push(match);
            return token;
        });
    }

    const strippedForDetection = masked
        .replace(PRESERVED_TOKEN_PATTERN, " ")
        .trim();

    return {
        hasMeaningfulText: /[\p{L}\p{N}]/u.test(strippedForDetection),
        restore: translatedText => translatedText.replace(PRESERVED_TOKEN_PATTERN, (_, index) => preservedValues[Number(index)] ?? ""),
        text: masked
    };
}

export function hasMeaningfulTextForTranslation(text: string) {
    return prepareTextForTranslation(text).hasMeaningfulText;
}

function writeReceivedChannelLanguageOverrides(settingKey: ReceivedChannelLanguageOverrideSetting, overrides: ReceivedChannelLanguageOverrideMap) {
    settings.store[settingKey] = serializeReceivedChannelLanguageOverrides(overrides);
}

export function getReceivedInputLanguageForChannel(
    channelId?: string | null,
    globalValue = settings.store.receivedInput,
    raw = settings.store.receivedChannelInputOverrides
) {
    if (!channelId) return globalValue;

    const overrides = parseReceivedChannelLanguageOverrides(raw);
    return overrides[channelId] ?? globalValue;
}

export function getReceivedOutputLanguageForChannel(
    channelId?: string | null,
    globalValue = settings.store.receivedOutput,
    raw = settings.store.receivedChannelOutputOverrides
) {
    if (!channelId) return globalValue;

    const overrides = parseReceivedChannelLanguageOverrides(raw);
    return overrides[channelId] ?? globalValue;
}

export function hasReceivedInputLanguageOverride(channelId?: string | null, raw = settings.store.receivedChannelInputOverrides) {
    if (!channelId) return false;
    return Object.prototype.hasOwnProperty.call(parseReceivedChannelLanguageOverrides(raw), channelId);
}

export function hasReceivedOutputLanguageOverride(channelId?: string | null, raw = settings.store.receivedChannelOutputOverrides) {
    if (!channelId) return false;
    return Object.prototype.hasOwnProperty.call(parseReceivedChannelLanguageOverrides(raw), channelId);
}

export function setReceivedInputLanguageForChannel(
    channelId: string,
    value: string,
    globalValue = settings.store.receivedInput,
    raw = settings.store.receivedChannelInputOverrides
) {
    const overrides = { ...parseReceivedChannelLanguageOverrides(raw) };

    if (!value || value === globalValue)
        delete overrides[channelId];
    else
        overrides[channelId] = value;

    writeReceivedChannelLanguageOverrides("receivedChannelInputOverrides", overrides);
}

export function setReceivedOutputLanguageForChannel(
    channelId: string,
    value: string,
    globalValue = settings.store.receivedOutput,
    raw = settings.store.receivedChannelOutputOverrides
) {
    const overrides = { ...parseReceivedChannelLanguageOverrides(raw) };

    if (!value || value === globalValue)
        delete overrides[channelId];
    else
        overrides[channelId] = value;

    writeReceivedChannelLanguageOverrides("receivedChannelOutputOverrides", overrides);
}

export function clearReceivedInputLanguageOverride(channelId: string, raw = settings.store.receivedChannelInputOverrides) {
    const overrides = { ...parseReceivedChannelLanguageOverrides(raw) };
    delete overrides[channelId];
    writeReceivedChannelLanguageOverrides("receivedChannelInputOverrides", overrides);
}

export function clearReceivedOutputLanguageOverride(channelId: string, raw = settings.store.receivedChannelOutputOverrides) {
    const overrides = { ...parseReceivedChannelLanguageOverrides(raw) };
    delete overrides[channelId];
    writeReceivedChannelLanguageOverrides("receivedChannelOutputOverrides", overrides);
}

export function getReceivedTranslationOptionsForChannel(
    channelId?: string | null,
    receivedInput = settings.store.receivedInput,
    receivedOutput = settings.store.receivedOutput,
    inputRaw = settings.store.receivedChannelInputOverrides,
    outputRaw = settings.store.receivedChannelOutputOverrides
): ReceivedTranslationOptions {
    const service = IS_WEB ? "google" : settings.store.service;
    return {
        sourceLang: normalizeLanguageForService(getReceivedInputLanguageForChannel(channelId, receivedInput, inputRaw), service, true),
        targetLang: normalizeLanguageForService(getReceivedOutputLanguageForChannel(channelId, receivedOutput, outputRaw), service, false)
    };
}

function countMessageLines(text: string) {
    if (!text) return 0;
    return text.split(/\r?\n/).length;
}

function hasCodeBlock(text: string) {
    return containsCodeFence(text);
}

function looksAlreadyTranslated(text: string) {
    return /(?:^|\n)\s*(?:\*?\(translated\)\*?|translated from\s+[^\n]+)\s*$/i.test(text.trim());
}

export function getAutomaticTranslationSkipReason(text: string): TranslationSkipResult | null {
    const {
        autoTranslateMaxCharacters,
        autoTranslateMaxLines,
        skipAlreadyTranslatedMessages,
        skipCodeBlockMessages
    } = settings.store;

    if (!hasMeaningfulTextForTranslation(text)) {
        return {
            reason: "Skipped: no translatable text",
            canTranslateManually: false
        };
    }

    if (skipCodeBlockMessages && hasCodeBlock(text)) {
        return {
            reason: "Skipped: contains code block",
            canTranslateManually: true
        };
    }

    if (skipAlreadyTranslatedMessages && looksAlreadyTranslated(text)) {
        return {
            reason: "Skipped: already looks translated",
            canTranslateManually: true
        };
    }

    if ((autoTranslateMaxCharacters || 0) > 0 && text.length > autoTranslateMaxCharacters) {
        return {
            reason: `Skipped: longer than ${autoTranslateMaxCharacters} characters`,
            canTranslateManually: true
        };
    }

    if ((autoTranslateMaxLines || 0) > 0 && countMessageLines(text) > autoTranslateMaxLines) {
        return {
            reason: `Skipped: more than ${autoTranslateMaxLines} lines`,
            canTranslateManually: true
        };
    }

    return null;
}

export function getReceivedTranslationCacheSignatureFromValues(
    receivedInput?: string,
    receivedOutput?: string,
    service = settings.store.service
) {
    const effectiveService = IS_WEB ? "google" : service;

    return createTranslationCacheSignature(
        effectiveService,
        receivedInput?.trim().toLowerCase(),
        receivedOutput?.trim().toLowerCase()
    );
}

export function getManualTranslationBlockReason(text: string): TranslationSkipResult | null {
    if (!hasMeaningfulTextForTranslation(text)) {
        return {
            reason: "Skipped: no translatable text",
            canTranslateManually: false
        };
    }

    return null;
}

export function normalizeTranslationFailureReason(error: unknown): string {
    const message = typeof error === "string"
        ? error
        : error instanceof Error
            ? error.message
            : String(error);

    if (/api key is not set/i.test(message))
        return "Failed: missing API key";
    if (/quota exceeded/i.test(message))
        return "Failed: quota exceeded";
    if (/low google detection confidence/i.test(message))
        return "Skipped: low Google detection confidence";
    if (/invalid .*api key|invalid azure|invalid deepl/i.test(message))
        return "Failed: invalid API key or service settings";
    if (/failed to connect|fetch failed|network|certificate|timed out/i.test(message))
        return "Failed: network or certificate error";
    if (isAbortError(error))
        return "Cancelled: translation request stopped";

    return "Failed: translation service error";
}

type MessageWithClientAliases = Message & {
    channel_id?: string;
    channelId?: string;
    guild_id?: string;
    guildId?: string;
};

export function getMessageChannelId(message: Message) {
    const messageWithMetadata = message as MessageWithClientAliases;
    return messageWithMetadata.channel_id ?? messageWithMetadata.channelId ?? "";
}

function parseIdList(cacheKey: "channels" | "guilds" | "users", value = "") {
    const cached = IgnoredIdListCache.get(cacheKey);
    if (cached?.raw === value) return cached.value;

    const ids = new Set(value.split(",").map(id => id.trim()).filter(Boolean));
    IgnoredIdListCache.set(cacheKey, { raw: value, value: ids });
    return ids;
}

function writeIdList(settingKey: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers", ids: Set<string>) {
    settings.store[settingKey] = Array.from(ids).join(",");
}

export function getIgnoredGuilds() {
    return parseIdList("guilds", settings.store.ignoredGuilds);
}

export function getIgnoredChannels() {
    return parseIdList("channels", settings.store.ignoredChannels);
}

export function getIgnoredUsers() {
    return parseIdList("users", settings.store.ignoredUsers);
}

export function isIgnoredGuild(guildId?: string | null) {
    return !!guildId && getIgnoredGuilds().has(guildId);
}

export function isIgnoredChannel(channelId?: string | null) {
    return !!channelId && getIgnoredChannels().has(channelId);
}

export function isIgnoredUser(userId?: string | null) {
    return !!userId && getIgnoredUsers().has(userId);
}

export function setIgnoredGuild(guildId: string, ignored: boolean) {
    const ignoredGuilds = new Set(getIgnoredGuilds());
    ignored ? ignoredGuilds.add(guildId) : ignoredGuilds.delete(guildId);
    writeIdList("ignoredGuilds", ignoredGuilds);
}

export function setIgnoredChannel(channelId: string, ignored: boolean) {
    const ignoredChannels = new Set(getIgnoredChannels());
    ignored ? ignoredChannels.add(channelId) : ignoredChannels.delete(channelId);
    writeIdList("ignoredChannels", ignoredChannels);
}

export function setIgnoredUser(userId: string, ignored: boolean) {
    const ignoredUsers = new Set(getIgnoredUsers());
    ignored ? ignoredUsers.add(userId) : ignoredUsers.delete(userId);
    writeIdList("ignoredUsers", ignoredUsers);
}

export function getMessageGuildId(message: Message, channelId = getMessageChannelId(message)) {
    const messageWithMetadata = message as MessageWithClientAliases;
    return messageWithMetadata.guild_id ?? messageWithMetadata.guildId ?? (channelId ? ChannelStore.getChannel(channelId)?.guild_id : undefined);
}

export function getAutomaticMessageSkipReason(message: Message, content: string): TranslationSkipResult | null {
    const channelId = getMessageChannelId(message);
    const guildId = getMessageGuildId(message, channelId);

    if (settings.store.skipBotMessages && message.author?.bot) {
        return {
            reason: "Skipped: bot message",
            canTranslateManually: true
        };
    }

    if (isIgnoredUser(message.author?.id)) {
        return {
            reason: "Skipped: ignored user",
            canTranslateManually: true
        };
    }

    if (isIgnoredChannel(channelId)) {
        return {
            reason: "Skipped: ignored channel",
            canTranslateManually: true
        };
    }

    if (isIgnoredGuild(guildId)) {
        return {
            reason: "Skipped: ignored server",
            canTranslateManually: true
        };
    }

    return getAutomaticTranslationSkipReason(content);
}

function writeReceivedChannelOverrides(overrides: ReceivedChannelOverrideMap) {
    settings.store.receivedChannelOverrides = serializeReceivedChannelOverrides(overrides);
}

export function hasReceivedAutoTranslateChannelOverride(channelId?: string | null, raw = settings.store.receivedChannelOverrides) {
    if (!channelId) return false;

    return Object.prototype.hasOwnProperty.call(parseReceivedChannelOverrides(raw), channelId);
}

export function getReceivedAutoTranslateChannelState(
    channelId?: string | null,
    globalEnabled = settings.store.autoTranslateReceived,
    raw = settings.store.receivedChannelOverrides
) {
    if (!channelId) return globalEnabled;

    const overrides = parseReceivedChannelOverrides(raw);
    return overrides[channelId] ?? globalEnabled;
}

export function setReceivedAutoTranslateChannelState(
    channelId: string,
    enabled: boolean,
    globalEnabled = settings.store.autoTranslateReceived,
    raw = settings.store.receivedChannelOverrides
) {
    const overrides = { ...parseReceivedChannelOverrides(raw) };

    if (enabled === globalEnabled)
        delete overrides[channelId];
    else
        overrides[channelId] = enabled;

    writeReceivedChannelOverrides(overrides);
}

export function clearReceivedAutoTranslateChannelOverride(channelId: string, raw = settings.store.receivedChannelOverrides) {
    const overrides = { ...parseReceivedChannelOverrides(raw) };
    delete overrides[channelId];
    writeReceivedChannelOverrides(overrides);
}

export async function translate(
    kind: "received" | "sent",
    text: string,
    options?: ReceivedTranslationOptions,
    signal?: AbortSignal
): Promise<TranslationValue> {
    const service = IS_WEB ? "google" : settings.store.service;
    const translateWithService = service === "google"
        ? googleTranslate
        : service === "azure"
            ? azureTranslate
            : deeplTranslate;
    const prepared = prepareTextForTranslation(text);
    const sourceLang = normalizeLanguageForService(options?.sourceLang ?? settings.store[`${kind}Input`], service, true);
    const targetLang = normalizeLanguageForService(options?.targetLang ?? settings.store[`${kind}Output`], service, false);
    const minimumGoogleConfidence = Number(settings.store.googleConfidenceRequirement) || 0;

    if (!prepared.hasMeaningfulText) {
        return {
            sourceLanguage: "",
            text
        };
    }

    const standaloneController = signal ? undefined : new AbortController();
    const requestSignal = signal ?? standaloneController?.signal;
    if (standaloneController)
        StandaloneTranslationControllers.add(standaloneController);

    try {
        requestSignal?.throwIfAborted();
        const translated = standaloneController
            ? await runLimitedTranslation(
                standaloneController.signal,
                limitedSignal => translateWithService(prepared.text, sourceLang, targetLang, limitedSignal)
            )
            : await translateWithService(prepared.text, sourceLang, targetLang, requestSignal);

        if (
            kind === "received"
            && service === "google"
            && !options?.ignoreConfidenceRequirement
            && minimumGoogleConfidence > 0
            && translated.confidence != null
            && translated.confidence < minimumGoogleConfidence
        )
            throw new Error(`Low Google detection confidence (${translated.confidence.toFixed(2)} < ${minimumGoogleConfidence.toFixed(2)})`);

        return {
            ...translated,
            text: prepared.restore(translated.text)
        };
    } catch (e) {
        if (e instanceof Error) throw e;
        throw new Error("Translation request failed.");
    } finally {
        if (standaloneController)
            StandaloneTranslationControllers.delete(standaloneController);
    }
}

function normalizeAzureLanguage(language: string, { isSource = false }: { isSource?: boolean; } = {}) {
    if (!language || language === "auto")
        return "";

    switch (language) {
        case "en-us":
        case "en-gb":
            return "en";
        case "zh-CN":
            return "zh-Hans";
        case "zh-TW":
            return "zh-Hant";
        case "iw":
            return "he";
        case "jw":
            return "jv";
        case "tl":
            return "fil";
        case "no":
            return isSource ? "nb" : "nb";
        default:
            return language;
    }
}

function azureLanguageToInternal(language: string) {
    switch (language) {
        case "zh-Hans":
            return "zh-CN";
        case "zh-Hant":
            return "zh-TW";
        case "he":
            return "iw";
        case "jv":
            return "jw";
        case "fil":
            return "tl";
        case "nb":
            return "no";
        default:
            return language.toLowerCase();
    }
}

function getAzureTranslateUrl(sourceLang: string, targetLang: string) {
    const endpoint = (settings.store.azureEndpoint || "https://api.cognitive.microsofttranslator.com").trim();
    const url = new URL(endpoint);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    const isGlobalEndpoint = url.hostname === "api.cognitive.microsofttranslator.com";

    if (!trimmedPath) {
        url.pathname = isGlobalEndpoint ? "/translate" : "/translator/text/v3.0/translate";
    } else if (/\/translator\/text\/v3\.0\/translate$/i.test(trimmedPath) || /\/translate$/i.test(trimmedPath)) {
        url.pathname = trimmedPath;
    } else if (/\/translator\/text\/v3\.0$/i.test(trimmedPath)) {
        url.pathname = `${trimmedPath}/translate`;
    } else {
        url.pathname = isGlobalEndpoint ? "/translate" : "/translator/text/v3.0/translate";
    }

    url.searchParams.set("api-version", "3.0");

    const normalizedSource = normalizeAzureLanguage(sourceLang, { isSource: true });
    const normalizedTarget = normalizeAzureLanguage(targetLang);

    if (!normalizedTarget)
        throw new Error("Azure Translator target language is not set.");

    if (normalizedSource)
        url.searchParams.set("from", normalizedSource);

    url.searchParams.append("to", normalizedTarget);
    return url.toString();
}

function createNativeRequestId() {
    return `chat-translator-${Date.now().toString(36)}-${(++nextNativeRequestId).toString(36)}`;
}

async function makeCancellableNativeRequest<T>(signal: AbortSignal | undefined, request: (requestId: string) => Promise<T>) {
    signal?.throwIfAborted();

    const requestId = createNativeRequestId();
    const cancelRequest = () => void Native.cancelRequest(requestId).catch(() => undefined);
    signal?.addEventListener("abort", cancelRequest, { once: true });

    try {
        const result = await request(requestId);
        signal?.throwIfAborted();
        return result;
    } finally {
        signal?.removeEventListener("abort", cancelRequest);
    }
}

export async function getDeeplUsage(signal?: AbortSignal): Promise<DeeplUsageResult> {
    if (IS_WEB)
        throw new Error("DeepL usage checks are not supported on web.");

    if (settings.store.service !== "deepl" && settings.store.service !== "deepl-pro")
        throw new Error("DeepL usage is only available when the translation service is set to DeepL.");

    if (!settings.store.deeplApiKey)
        throw new Error("DeepL API key is not set.");

    const { status, data } = await makeCancellableNativeRequest(
        signal,
        requestId => Native.makeDeeplUsageRequest(
            settings.store.service === "deepl-pro",
            settings.store.deeplApiKey,
            requestId
        )
    );

    switch (status) {
        case 200:
            break;
        case -1:
            throw new Error("Failed to connect to DeepL API.");
        case 403:
            throw new Error("Invalid DeepL API key or version.");
        case 456:
            throw new Error("DeepL API quota exceeded.");
        default:
            throw new Error(`Failed to retrieve DeepL usage (${status}).`);
    }

    const parsed: unknown = JSON.parse(data);
    if (!isObject(parsed)
        || !("character_count" in parsed)
        || typeof parsed.character_count !== "number"
        || !("character_limit" in parsed)
        || typeof parsed.character_limit !== "number")
        throw new Error("DeepL returned an invalid usage response.");

    return {
        characterCount: parsed.character_count,
        characterLimit: parsed.character_limit,
        apiKeyCharacterCount: "api_key_character_count" in parsed && typeof parsed.api_key_character_count === "number" ? parsed.api_key_character_count : undefined,
        apiKeyCharacterLimit: "api_key_character_limit" in parsed && typeof parsed.api_key_character_limit === "number" ? parsed.api_key_character_limit : undefined,
        startTime: "start_time" in parsed && typeof parsed.start_time === "string" ? parsed.start_time : undefined,
        endTime: "end_time" in parsed && typeof parsed.end_time === "string" ? parsed.end_time : undefined
    };
}

async function readLimitedResponseText(response: Response) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_TRANSLATION_RESPONSE_LENGTH) {
        await response.body?.cancel();
        throw new Error("Translation response is too large.");
    }

    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedLength = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            receivedLength += value.byteLength;
            if (receivedLength > MAX_TRANSLATION_RESPONSE_LENGTH) {
                await reader.cancel();
                throw new Error("Translation response is too large.");
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(receivedLength);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(body);
}

async function googleTranslate(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<TranslationValue> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        client: "gtx",
        sl: sourceLang || "auto",
        tl: targetLang,
        dt: "t",
        dj: "1",
        q: text,
    });

    signal?.throwIfAborted();

    const controller = new AbortController();
    let timedOut = false;
    const cancelRequest = () => controller.abort();
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, NETWORK_REQUEST_TIMEOUT_MS);
    signal?.addEventListener("abort", cancelRequest, { once: true });
    if (signal?.aborted)
        controller.abort();

    let response: unknown;
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok)
            throw new Error(`Google Translate request failed (${res.status} ${res.statusText}).`);

        const responseText = await readLimitedResponseText(res);
        try {
            response = JSON.parse(responseText) as unknown;
        } catch {
            throw new Error("Google Translate returned an invalid response.");
        }
    } catch (error) {
        if (timedOut)
            throw new Error("Google Translate request timed out.");
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancelRequest);
    }

    if (!isObject(response))
        throw new Error("Google Translate returned an invalid response.");

    const sourceLanguage = "sourceLanguage" in response && typeof response.sourceLanguage === "string"
        ? response.sourceLanguage
        : "src" in response && typeof response.src === "string"
            ? response.src
            : sourceLang;
    const translation = "translation" in response && typeof response.translation === "string"
        ? response.translation
        : "sentences" in response && Array.isArray(response.sentences)
            ? response.sentences
                .map(sentence => isObject(sentence) && "trans" in sentence && typeof sentence.trans === "string" ? sentence.trans : "")
                .join("")
            : "";

    if (!translation)
        throw new Error("Google Translate returned an empty translation response.");

    return {
        confidence: "confidence" in response && typeof response.confidence === "number" ? response.confidence : undefined,
        sourceLanguage: getLanguageDisplayName(sourceLanguage),
        text: translation
    };
}

async function azureTranslate(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<TranslationValue> {
    if (!settings.store.azureApiKey)
        throw new Error("Azure Translator API key is not set.");

    const { status, data } = await makeCancellableNativeRequest(
        signal,
        requestId => Native.makeAzureTranslateRequest(
            getAzureTranslateUrl(sourceLang, targetLang),
            settings.store.azureApiKey,
            settings.store.azureRegion.trim(),
            JSON.stringify([{ Text: text }]),
            requestId
        )
    );

    switch (status) {
        case 200:
            break;
        case -1:
            throw new Error("Failed to connect to Azure Translator API.");
        case 401:
        case 403:
            throw new Error("Invalid Azure Translator API key, endpoint, or region.");
        case 429:
            throw new Error("Azure Translator rate limit exceeded.");
        default:
            throw new Error(`Failed to translate with Azure Translator (${status}).`);
    }

    const parsed: unknown = JSON.parse(data);
    const firstResult = Array.isArray(parsed) ? parsed[0] : undefined;
    const translated = isObject(firstResult)
        && "translations" in firstResult
        && Array.isArray(firstResult.translations)
        && isObject(firstResult.translations[0])
        ? firstResult.translations[0]
        : undefined;

    if (!translated
        || !("text" in translated)
        || typeof translated.text !== "string"
        || !("to" in translated)
        || typeof translated.to !== "string")
        throw new Error("Azure Translator returned an empty translation response.");

    const detectedLanguage = isObject(firstResult)
        && "detectedLanguage" in firstResult
        && isObject(firstResult.detectedLanguage)
        && "language" in firstResult.detectedLanguage
        && typeof firstResult.detectedLanguage.language === "string"
        ? firstResult.detectedLanguage.language
        : undefined;
    const detectedSource = detectedLanguage
        ? azureLanguageToInternal(detectedLanguage)
        : normalizeAzureLanguage(sourceLang, { isSource: true });

    return {
        sourceLanguage: getLanguageDisplayName(detectedSource),
        text: translated.text
    };
}

export async function testAzureConnection(signal?: AbortSignal): Promise<AzureConnectionResult> {
    return azureTranslate("안녕하세요", "auto", "en", signal);
}

function fallbackToGoogle(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<TranslationValue> {
    return googleTranslate(
        text,
        deeplLanguageToGoogleLanguage(sourceLang),
        deeplLanguageToGoogleLanguage(targetLang),
        signal
    );
}

const showDeeplApiQuotaToast = onlyOnce(
    () => showToast("Deepl API quota exceeded. Falling back to Google Translate", Toasts.Type.FAILURE)
);

async function deeplTranslate(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<TranslationValue> {
    if (!settings.store.deeplApiKey) {
        showDedupedErrorToast("DeepL API key is not set. Resetting to Google");

        settings.store.service = "google";
        resetLanguageDefaults();

        return fallbackToGoogle(text, sourceLang, targetLang, signal);
    }

    const payload: {
        text: string[];
        target_lang: string;
        source_lang?: string;
    } = {
        text: [text],
        target_lang: targetLang
    };

    if (sourceLang && sourceLang !== "auto")
        payload.source_lang = sourceLang.split("-")[0];

    const { status, data } = await makeCancellableNativeRequest(
        signal,
        requestId => Native.makeDeeplTranslateRequest(
            settings.store.service === "deepl-pro",
            settings.store.deeplApiKey,
            JSON.stringify(payload),
            requestId
        )
    );

    switch (status) {
        case 200:
            break;
        case -1:
            throw new Error("Failed to connect to DeepL API.");
        case 403:
            throw new Error("Invalid DeepL API key or version");
        case 456:
            showDeeplApiQuotaToast();
            return fallbackToGoogle(text, sourceLang, targetLang, signal);
        default:
            throw new Error(`DeepL translation request failed (${status}).`);
    }

    const parsed: unknown = JSON.parse(data);
    const translation = isObject(parsed)
        && "translations" in parsed
        && Array.isArray(parsed.translations)
        && isObject(parsed.translations[0])
        ? parsed.translations[0]
        : undefined;

    if (!translation
        || !("detected_source_language" in translation)
        || typeof translation.detected_source_language !== "string"
        || !("text" in translation)
        || typeof translation.text !== "string")
        throw new Error("DeepL returned an invalid translation response.");

    return {
        sourceLanguage: getLanguageDisplayName(translation.detected_source_language),
        text: translation.text
    };
}
