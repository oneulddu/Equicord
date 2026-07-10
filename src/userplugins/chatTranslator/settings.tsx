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

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { normalizeChannelLanguageOverrides, normalizeLanguageForService } from "./languageOverrides";
import { ChatTranslatorSettingsView } from "./SettingsView";

function StandardSettingsView() {
    return <ChatTranslatorSettingsView settings={settings} />;
}

export const settings = definePluginSettings({
    settingsPanel: {
        type: OptionType.COMPONENT,
        description: "Configure translation services, languages, channel overrides, and quick actions from the standard plugin settings page.",
        component: StandardSettingsView
    },
    defaultTargetLanguage: {
        type: OptionType.STRING,
        description: "Default language that received and sent messages should translate to.",
        default: "en",
        hidden: true
    },
    useSeparateSentLanguage: {
        type: OptionType.BOOLEAN,
        description: "Use a separate target language for sent messages.",
        default: false,
        hidden: true
    },
    receivedInput: {
        type: OptionType.STRING,
        description: "Language that received messages should be translated from.",
        default: "auto",
        hidden: true
    },
    receivedOutput: {
        type: OptionType.STRING,
        description: "Language that received messages should be translated to.",
        default: "en",
        hidden: true
    },
    sentInput: {
        type: OptionType.STRING,
        description: "Language that your own messages should be translated from.",
        default: "auto",
        hidden: true
    },
    sentOutput: {
        type: OptionType.STRING,
        description: "Language that your own messages should be translated to.",
        default: "en",
        hidden: true
    },

    service: {
        type: OptionType.SELECT,
        description: IS_WEB ? "Translation service (Not supported on Web!)." : "Translation service.",
        disabled: () => IS_WEB,
        options: [
            { label: "Google Translate", value: "google", default: true },
            { label: "DeepL Free", value: "deepl" },
            { label: "DeepL Pro", value: "deepl-pro" },
            { label: "Azure Translator", value: "azure" }
        ] as const,
        onChange: resetLanguageDefaults,
        hidden: true
    },
    azureRegion: {
        type: OptionType.STRING,
        description: "Azure Translator region. Optional for global Translator resources, required for regional and multi-service resources.",
        default: "",
        placeholder: "e.g. koreacentral",
        disabled: () => IS_WEB,
        hidden: true
    },
    azureEndpoint: {
        type: OptionType.STRING,
        description: "Azure Translator endpoint base URL.",
        default: "https://api.cognitive.microsofttranslator.com",
        placeholder: "https://api.cognitive.microsofttranslator.com",
        disabled: () => IS_WEB,
        hidden: true
    },
    deeplApiKey: {
        type: OptionType.STRING,
        description: "DeepL API key.",
        default: "",
        hidden: true,
        disabled: () => IS_WEB
    },
    azureApiKey: {
        type: OptionType.STRING,
        description: "Azure Translator API key.",
        default: "",
        hidden: true,
        disabled: () => IS_WEB
    },
    autoTranslate: {
        type: OptionType.BOOLEAN,
        description: "Automatically translate your messages before sending. You can also shift/click the translate button to toggle this.",
        default: false,
        hidden: true
    },
    autoTranslateReceived: {
        type: OptionType.BOOLEAN,
        description: "Automatically translate visible received messages as they render. Existing messages translate when they scroll on screen.",
        default: false,
        hidden: true
    },
    replaceMessageContent: {
        type: OptionType.BOOLEAN,
        description: "Experimental: replace received message text directly instead of showing an accessory.",
        default: true,
        hidden: true
    },
    inlineReplacementMigrationDone: {
        type: OptionType.BOOLEAN,
        description: "Tracks whether inline message replacement was enabled for rain ChatTranslate compatibility.",
        default: false,
        hidden: true
    },
    simpleMode: {
        type: OptionType.BOOLEAN,
        description: "Show a minimal translated indicator and hide advanced per-message actions.",
        default: false,
        hidden: true
    },
    receivedDisplayMode: {
        type: OptionType.SELECT,
        description: "How translated text should be shown in the accessory.",
        options: [
            { label: "Translated Only", value: "translated", default: true },
            { label: "Translated + Original", value: "dual" },
            { label: "Toggle Original / Translation", value: "toggle" },
            { label: "Compact Indicator", value: "compact" }
        ] as const,
        hidden: true
    },
    collapseTranslatedMessages: {
        type: OptionType.BOOLEAN,
        description: "Collapse translated messages by default.",
        default: true,
        hidden: true
    },
    autoTranslateMaxCharacters: {
        type: OptionType.NUMBER,
        description: "Skip automatic translation when the message is longer than this many characters.",
        default: 500,
        hidden: true
    },
    autoTranslateMaxLines: {
        type: OptionType.NUMBER,
        description: "Skip automatic translation when the message has more than this many lines.",
        default: 12,
        hidden: true
    },
    skipCodeBlockMessages: {
        type: OptionType.BOOLEAN,
        description: "Skip automatic translation when a message contains code blocks.",
        default: true,
        hidden: true
    },
    skipAlreadyTranslatedMessages: {
        type: OptionType.BOOLEAN,
        description: "Skip automatic translation when a message already looks translated.",
        default: true,
        hidden: true
    },
    showTranslationFailureReasons: {
        type: OptionType.BOOLEAN,
        description: "Show skip and failure reasons for automatic translations. Manual translations still show errors.",
        default: false,
        hidden: true
    },
    translationCacheTtlDays: {
        type: OptionType.NUMBER,
        description: "Remove cached received-message translations older than this many days. Set to 0 to keep them until the cache limit or manual clear.",
        default: 14,
        hidden: true
    },
    googleConfidenceRequirement: {
        type: OptionType.NUMBER,
        description: "Minimum Google language detection confidence for automatic received-message translation. Set to 0 to disable.",
        default: 0,
        hidden: true
    },
    skipBotMessages: {
        type: OptionType.BOOLEAN,
        description: "Skip automatic translation for bot messages.",
        default: true,
        hidden: true
    },
    ignoredGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated server IDs to skip during automatic received-message translation.",
        default: "",
        hidden: true
    },
    ignoredChannels: {
        type: OptionType.STRING,
        description: "Comma-separated channel IDs to skip during automatic received-message translation.",
        default: "",
        hidden: true
    },
    ignoredUsers: {
        type: OptionType.STRING,
        description: "Comma-separated user IDs to skip during automatic received-message translation.",
        default: "",
        hidden: true
    },
    receivedChannelOverrides: {
        type: OptionType.STRING,
        description: "Per-channel received auto translate overrides.",
        default: "{}",
        hidden: true
    },
    sentChannelOverrides: {
        type: OptionType.STRING,
        description: "Per-channel sent auto translate overrides.",
        default: "{}",
        hidden: true
    },
    receivedChannelInputOverrides: {
        type: OptionType.STRING,
        description: "Per-channel received input language overrides.",
        default: "{}",
        hidden: true
    },
    receivedChannelOutputOverrides: {
        type: OptionType.STRING,
        description: "Per-channel received output language overrides.",
        default: "{}",
        hidden: true
    },
    showAutoTranslateTooltip: {
        type: OptionType.BOOLEAN,
        description: "Show a tooltip on the ChatBar button whenever one of your messages is automatically translated before sending.",
        default: true,
        hidden: true
    },
    showAutoTranslateAlert: {
        type: OptionType.BOOLEAN,
        description: "Show the received auto translate information alert.",
        default: true,
        hidden: true
    }
});

export type ChatTranslatorSettings = typeof settings;

export function resetLanguageDefaults() {
    const { service } = settings.store;

    settings.store.receivedInput = normalizeLanguageForService(settings.store.receivedInput, service, true);
    settings.store.receivedOutput = normalizeLanguageForService(settings.store.receivedOutput, service, false);
    settings.store.sentInput = normalizeLanguageForService(settings.store.sentInput, service, true);
    settings.store.sentOutput = normalizeLanguageForService(settings.store.sentOutput, service, false);
    settings.store.receivedChannelInputOverrides = normalizeChannelLanguageOverrides(settings.store.receivedChannelInputOverrides, service, true);
    settings.store.receivedChannelOutputOverrides = normalizeChannelLanguageOverrides(settings.store.receivedChannelOutputOverrides, service, false);
}
