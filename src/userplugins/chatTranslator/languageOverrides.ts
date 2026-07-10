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

import { Logger } from "@utils/Logger";

import { DeeplLanguages, deeplLanguageToGoogleLanguage, GoogleLanguages } from "./languages";

export type TranslationService = "google" | "deepl" | "deepl-pro" | "azure";
export type ReceivedChannelOverrideMap = Record<string, boolean>;
export type ReceivedChannelLanguageOverrideMap = Record<string, string>;
export type ReceivedChannelLanguageOverrideSetting = "receivedChannelInputOverrides" | "receivedChannelOutputOverrides";

const OverrideLogger = new Logger("ChatTranslatorOverrides");
let cachedReceivedChannelOverrides: { raw: string; value: ReceivedChannelOverrideMap; } | undefined;
const CachedReceivedChannelLanguageOverrides = new Map<string, ReceivedChannelLanguageOverrideMap>();
const MAX_CACHED_LANGUAGE_OVERRIDE_VALUES = 4;

export function clearLanguageOverrideCaches() {
    cachedReceivedChannelOverrides = undefined;
    CachedReceivedChannelLanguageOverrides.clear();
}

function googleLanguageToDeeplLanguage(language?: string): string {
    switch (language) {
        case "auto": return "";
        case "no": return "nb";
        case "zh-CN": return "zh-hans";
        case "zh-TW": return "zh-hant";
        case "en": return "en-us";
        case "pt": return "pt-br";
        default: return language ?? "";
    }
}

export function normalizeLanguageForService(language: string | undefined, service: string | undefined, isInput: boolean): string {
    const isGoogleLikeService = IS_WEB || service === "google" || service === "azure";
    const googleLikeLanguage = deeplLanguageToGoogleLanguage(language || "");

    if (isGoogleLikeService) {
        if (googleLikeLanguage in GoogleLanguages)
            return googleLikeLanguage;

        return isInput ? "auto" : "en";
    }

    if (language != null && language in DeeplLanguages)
        return language;

    const deeplLanguage = googleLanguageToDeeplLanguage(googleLikeLanguage);

    if (deeplLanguage in DeeplLanguages)
        return deeplLanguage;

    return isInput ? "" : "en-us";
}

export function parseReceivedChannelOverrides(raw = "{}"): ReceivedChannelOverrideMap {
    const normalizedRaw = raw || "{}";
    if (cachedReceivedChannelOverrides?.raw === normalizedRaw)
        return cachedReceivedChannelOverrides.value;

    let value: ReceivedChannelOverrideMap;

    try {
        const parsed: unknown = JSON.parse(normalizedRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            value = {};
        else
            value = Object.fromEntries(
                Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[0] === "string" && typeof entry[1] === "boolean")
            );
    } catch (error) {
        OverrideLogger.warn("Failed to parse received channel overrides", error);
        value = {};
    }

    cachedReceivedChannelOverrides = { raw: normalizedRaw, value };
    return value;
}

export function parseReceivedChannelLanguageOverrides(raw = "{}"): ReceivedChannelLanguageOverrideMap {
    const normalizedRaw = raw || "{}";
    const cached = CachedReceivedChannelLanguageOverrides.get(normalizedRaw);
    if (cached) return cached;

    let value: ReceivedChannelLanguageOverrideMap;

    try {
        const parsed: unknown = JSON.parse(normalizedRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            value = {};
        else
            value = Object.fromEntries(
                Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
            );
    } catch (error) {
        OverrideLogger.warn("Failed to parse received channel language overrides", error);
        value = {};
    }

    CachedReceivedChannelLanguageOverrides.set(normalizedRaw, value);
    while (CachedReceivedChannelLanguageOverrides.size > MAX_CACHED_LANGUAGE_OVERRIDE_VALUES) {
        const oldest = CachedReceivedChannelLanguageOverrides.keys().next();
        if (oldest.done) break;
        CachedReceivedChannelLanguageOverrides.delete(oldest.value);
    }

    return value;
}

export function serializeReceivedChannelOverrides(overrides: ReceivedChannelOverrideMap) {
    return JSON.stringify(overrides);
}

export function serializeReceivedChannelLanguageOverrides(overrides: ReceivedChannelLanguageOverrideMap) {
    return JSON.stringify(overrides);
}

export function normalizeChannelLanguageOverrides(raw: string | undefined, service: string | undefined, isInput: boolean) {
    const normalized = Object.fromEntries(
        Object.entries(parseReceivedChannelLanguageOverrides(raw))
            .map(([channelId, language]) => [channelId, normalizeLanguageForService(language, service, isInput)])
    );

    return JSON.stringify(normalized);
}
