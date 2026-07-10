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

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary } from "@components/Heading";
import { Margins } from "@utils/margins";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, SearchableSelect, SelectedChannelStore, SelectedGuildStore, showToast, TextInput, Toasts, useEffect, useMemo, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { normalizeLanguageForService } from "./languageOverrides";
import {
    clearSentAutoTranslateChannelOverride,
    getSentAutoTranslateChannelState,
    hasSentAutoTranslateChannelOverride,
    setSentAutoTranslateChannelState
} from "./sentTranslation";
import { type ChatTranslatorSettings, resetLanguageDefaults } from "./settings";
import {
    clearChannelTranslationCache,
    clearTranslationCache,
    clearTranslationCacheForSignature,
    getTranslationCacheStats,
    getTranslationCacheStatsVersion,
    pruneExpiredTranslationCache,
    subscribeTranslationCacheStatsVersion
} from "./TranslationAccessory";
import { isAbortError } from "./translationState";
import {
    cl,
    clearReceivedAutoTranslateChannelOverride,
    clearReceivedInputLanguageOverride,
    clearReceivedOutputLanguageOverride,
    getDeeplUsage,
    getLanguageDisplayName,
    getLanguages,
    getReceivedAutoTranslateChannelState,
    getReceivedInputLanguageForChannel,
    getReceivedOutputLanguageForChannel,
    getReceivedTranslationCacheSignatureFromValues,
    getReceivedTranslationOptionsForChannel,
    hasReceivedAutoTranslateChannelOverride,
    hasReceivedInputLanguageOverride,
    hasReceivedOutputLanguageOverride,
    normalizeTranslationFailureReason,
    setReceivedAutoTranslateChannelState,
    setReceivedInputLanguageForChannel,
    setReceivedOutputLanguageForChannel,
    testAzureConnection
} from "./utils";

type PluginSettingsLike = ChatTranslatorSettings;
type SettingKey = keyof PluginSettingsLike["store"];

function settingKeys(...keys: SettingKey[]) {
    return keys;
}

const LanguageSettingKeys = ["receivedInput", "receivedOutput", "sentInput", "sentOutput"] as const;
const SERVICE_SETTING_KEYS = settingKeys("service");
const SERVICE_CONFIG_SETTING_KEYS = settingKeys("service", "deeplApiKey", "azureApiKey", "azureRegion", "azureEndpoint");
const DEEPL_USAGE_SETTING_KEYS = settingKeys("service", "deeplApiKey");
const CURRENT_CHANNEL_SETTING_KEYS = settingKeys(
    "autoTranslate",
    "autoTranslateReceived",
    "receivedInput",
    "receivedOutput",
    "receivedChannelOverrides",
    "sentChannelOverrides",
    "receivedChannelInputOverrides",
    "receivedChannelOutputOverrides",
    "service"
);
const DISPLAY_SETTING_KEYS = settingKeys("receivedDisplayMode", "collapseTranslatedMessages");
const AUTO_SKIP_SETTING_KEYS = settingKeys(
    "autoTranslateMaxCharacters",
    "autoTranslateMaxLines",
    "googleConfidenceRequirement",
    "translationCacheTtlDays",
    "skipCodeBlockMessages",
    "showTranslationFailureReasons"
);
const CACHE_SETTING_KEYS = settingKeys(
    "service",
    "receivedInput",
    "receivedOutput",
    "receivedChannelInputOverrides",
    "receivedChannelOutputOverrides",
    "translationCacheTtlDays"
);

const ServiceOptions = [
    { value: "google", label: "Google Translate" },
    { value: "deepl", label: "DeepL Free" },
    { value: "deepl-pro", label: "DeepL Pro" },
    { value: "azure", label: "Azure Translator" }
] as const;

const DisplayModeOptions = [
    { value: "translated", label: "Translated Only" },
    { value: "dual", label: "Translated + Original" },
    { value: "toggle", label: "Toggle Original / Translation" },
    { value: "compact", label: "Compact Indicator" }
] as const;

const GoogleConfidencePresetOptions = [
    { value: "0.5", label: "Loose (translate more, may misdetect)" },
    { value: "0.8", label: "Balanced (recommended)" },
    { value: "0.9", label: "Strict (avoid mistaken translations)" },
    { value: "custom", label: "Custom" }
] as const;

type SelectOption = {
    value: string;
    label: string;
};

interface IgnoredEntityOptionState {
    labels: Record<string, string>;
    options: SelectOption[];
}

const IgnoredGuildStores = [GuildStore];
const IgnoredChannelStores = [ChannelStore, GuildChannelStore, GuildStore, UserStore];
const IgnoredUserStores = [ChannelStore, GuildMemberStore, UserStore];

function SectionCard({ children, tone }: { children: React.ReactNode; tone?: "hero" | "accent"; }) {
    return (
        <section className={cl("settings-card", tone === "hero" ? "settings-card-hero" : undefined, tone === "accent" ? "settings-card-accent" : undefined)}>
            {children}
        </section>
    );
}

function SectionNote({ children, muted = true }: { children: React.ReactNode; muted?: boolean; }) {
    return (
        <BaseText size="sm" color={muted ? "text-muted" : "text-default"} className={cl("settings-note")}>
            {children}
        </BaseText>
    );
}

function SectionHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode; }) {
    return (
        <div className={cl("settings-section-header")}>
            {eyebrow && <span className={cl("settings-eyebrow")}>{eyebrow}</span>}
            <HeadingSecondary>{title}</HeadingSecondary>
            {children && <SectionNote>{children}</SectionNote>}
        </div>
    );
}

function SettingsGrid({ children }: { children: React.ReactNode; }) {
    return <div className={cl("settings-grid")}>{children}</div>;
}

function ButtonRow({ children }: { children: React.ReactNode; }) {
    return <div className={cl("settings-button-row")}>{children}</div>;
}

function SelectSetting({
    title,
    value,
    options,
    placeholder,
    onChange
}: {
    title: string;
    value: string;
    options: ReadonlyArray<{ value: string; label: string; }>;
    placeholder: string;
    onChange: (value: string) => void;
}) {
    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>{title}</HeadingSecondary>
            <SearchableSelect
                options={options}
                value={options.find(option => option.value === value)?.value}
                placeholder={placeholder}
                maxVisibleItems={6}
                closeOnSelect={true}
                onChange={onChange}
            />
        </section>
    );
}

function NumberSetting({
    title,
    description,
    value,
    onChange,
    placeholder
}: {
    title: string;
    description: string;
    value: number;
    onChange: (value: number) => void;
    placeholder?: string;
}) {
    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>{title}</HeadingSecondary>
            <SectionNote>{description}</SectionNote>
            <TextInput
                type="number"
                value={String(value)}
                placeholder={placeholder}
                onChange={value => onChange(Math.max(0, Number(value) || 0))}
            />
        </section>
    );
}

function LanguageSelect({ settings, settingsKey, includeAuto }: { settings: PluginSettingsLike; settingsKey: typeof LanguageSettingKeys[number]; includeAuto: boolean; }) {
    const subscriptionKeys = useMemo<SettingKey[]>(() => [settingsKey, "service"], [settingsKey]);
    const settingValues = settings.use(subscriptionKeys);
    const { service } = settingValues;
    const effectiveService = IS_WEB ? "google" : service;
    const currentValue = normalizeLanguageForService(settingValues[settingsKey], effectiveService, includeAuto);

    const options = useMemo(() => {
        const languageOptions = Object.entries(getLanguages()).map(([value, label]) => ({ value, label }));
        if (!includeAuto)
            languageOptions.shift();

        return languageOptions;
    }, [includeAuto, service]);

    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>
                {settings.def[settingsKey].description}
            </HeadingSecondary>

            <SearchableSelect
                options={options}
                value={options.find(option => option.value === currentValue)?.value}
                placeholder="Select a language"
                maxVisibleItems={5}
                closeOnSelect={true}
                onChange={value => settings.store[settingsKey] = value}
            />
        </section>
    );
}

function AutoTranslateToggle({
    settings,
    setting,
    title
}: {
    settings: PluginSettingsLike;
    setting:
    | "autoTranslate"
    | "autoTranslateReceived"
    | "showAutoTranslateTooltip"
    | "replaceMessageContent"
    | "simpleMode"
    | "collapseTranslatedMessages"
    | "skipCodeBlockMessages"
    | "skipAlreadyTranslatedMessages"
    | "skipBotMessages"
    | "showTranslationFailureReasons";
    title: string;
}) {
    const subscriptionKeys = useMemo<SettingKey[]>(() => [setting], [setting]);
    const value = settings.use(subscriptionKeys)[setting];

    return (
        <FormSwitch
            title={title}
            description={settings.def[setting].description}
            value={value}
            onChange={enabled => settings.store[setting] = enabled}
            hideBorder
        />
    );
}

function getIgnoredEntityLabel(setting: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers", id: string) {
    if (setting === "ignoredChannels") {
        const channel = ChannelStore.getChannel(id);
        if (channel?.name)
            return `#${channel.name}`;

        return "Unknown channel";
    }

    if (setting === "ignoredGuilds")
        return GuildStore.getGuild(id)?.name ?? "Unknown server";

    const user = UserStore.getUser(id);
    if (!user)
        return "Unknown user";

    const displayName = user.globalName ?? user.username ?? "Unknown user";
    return user.username && user.username !== displayName
        ? `${displayName} (@${user.username})`
        : displayName;
}

function getUserLabel(userId: string, guildId?: string | null) {
    const user = UserStore.getUser(userId);
    if (!user) return userId;

    const guildNick = guildId ? GuildMemberStore.getNick?.(guildId, userId) : undefined;
    const displayName = guildNick ?? user.globalName ?? user.username ?? userId;

    return user.username && user.username !== displayName
        ? `${displayName} (@${user.username})`
        : displayName;
}

function getChannelLabel(channel: Channel | undefined | null) {
    if (!channel) return "Unknown channel";

    const rawRecipientNames = channel.rawRecipients
        ?.map(user => user.global_name ?? user.display_name ?? user.username)
        .filter(Boolean)
        .join(", ");
    const recipientNames = channel.recipients
        ?.map(id => {
            const user = UserStore.getUser(id);
            return user?.globalName ?? user?.username;
        })
        .filter(Boolean)
        .join(", ");
    const channelName = channel.name ? `#${channel.name}` : rawRecipientNames || recipientNames || "DM";
    const guildName = channel.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : "DM";

    return guildName ? `${channelName} — ${guildName}` : channelName;
}

function pushUniqueOption(options: SelectOption[], seen: Set<string>, value: string | undefined, label: string | undefined) {
    if (!value || seen.has(value)) return;

    seen.add(value);
    options.push({ value, label: label || value });
}

function getSelectableChannelOptions(excludedIds: Set<string>) {
    const options: SelectOption[] = [];
    const seen = new Set<string>();

    for (const guild of Object.values(GuildStore.getGuilds())) {
        for (const { channel } of GuildChannelStore.getSelectableChannels(guild.id)) {
            if (!channel?.id || excludedIds.has(channel.id)) continue;

            pushUniqueOption(options, seen, channel.id, getChannelLabel(channel));
        }
    }

    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        if (!channel?.id || excludedIds.has(channel.id)) continue;

        pushUniqueOption(options, seen, channel.id, getChannelLabel(channel));
    }

    return options.sort((a, b) => a.label.localeCompare(b.label));
}

function getSelectableUserOptions(excludedIds: Set<string>, currentGuildId?: string | null) {
    const options: SelectOption[] = [];
    const seen = new Set<string>();

    if (currentGuildId) {
        for (const userId of GuildMemberStore.getMemberIds(currentGuildId))
            if (!excludedIds.has(userId))
                pushUniqueOption(options, seen, userId, getUserLabel(userId, currentGuildId));
    }

    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        const recipientIds = channel.recipients ?? [];

        for (const userId of recipientIds) {
            if (!userId || excludedIds.has(userId)) continue;

            const user = UserStore.getUser(userId);
            if (!user) continue;

            pushUniqueOption(options, seen, userId, getUserLabel(userId));
        }
    }

    return options.sort((a, b) => a.label.localeCompare(b.label));
}

function getIgnoredEntityOptions(setting: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers", ids: string[], currentGuildId?: string | null) {
    const excludedIds = new Set(ids);

    if (setting === "ignoredGuilds") {
        return Object.values(GuildStore.getGuilds())
            .filter(guild => guild?.id && !excludedIds.has(guild.id))
            .map(guild => ({ value: guild.id, label: guild.name ?? guild.id }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    if (setting === "ignoredChannels")
        return getSelectableChannelOptions(excludedIds);

    return getSelectableUserOptions(excludedIds, currentGuildId);
}

function getIgnoredEntityStores(setting: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers") {
    if (setting === "ignoredGuilds") return IgnoredGuildStores;
    if (setting === "ignoredChannels") return IgnoredChannelStores;
    return IgnoredUserStores;
}

function areIgnoredEntityOptionStatesEqual(previous: IgnoredEntityOptionState, next: IgnoredEntityOptionState) {
    if (previous.options.length !== next.options.length) return false;
    if (previous.options.some((option, index) => option.value !== next.options[index].value || option.label !== next.options[index].label))
        return false;

    const previousLabels = Object.entries(previous.labels);
    const nextLabels = Object.entries(next.labels);
    return previousLabels.length === nextLabels.length
        && previousLabels.every(([id, label]) => next.labels[id] === label);
}

function IgnoredIdListSetting({
    settings,
    setting,
    title,
    description,
    currentEntityId,
    currentGuildId
}: {
    settings: PluginSettingsLike;
    setting: "ignoredGuilds" | "ignoredChannels" | "ignoredUsers";
    title: string;
    description: string;
    currentEntityId?: string | null;
    currentGuildId?: string | null;
}) {
    const subscriptionKeys = useMemo<SettingKey[]>(() => [setting], [setting]);
    const value = settings.use(subscriptionKeys)[setting] ?? "";
    const ids = useMemo(() => value.split(",").map(id => id.trim()).filter(Boolean), [value]);
    const { labels, options } = useStateFromStores(
        getIgnoredEntityStores(setting),
        () => ({
            labels: Object.fromEntries(ids.map(id => [id, getIgnoredEntityLabel(setting, id)])),
            options: getIgnoredEntityOptions(setting, ids, currentGuildId)
        }),
        [currentGuildId, ids, setting],
        areIgnoredEntityOptionStatesEqual
    );
    const addId = (idToAdd: string | undefined | null) => {
        const normalizedId = idToAdd?.trim();
        if (!normalizedId || ids.includes(normalizedId)) return;

        settings.store[setting] = [...ids, normalizedId].join(",");
    };
    const removeId = (idToRemove: string) => {
        settings.store[setting] = ids.filter(id => id !== idToRemove).join(",");
    };
    const canAddCurrentEntity = !!currentEntityId && !ids.includes(currentEntityId);

    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>{title}</HeadingSecondary>
            <SectionNote>{description} Current entries: {ids.length}.</SectionNote>
            {options.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                    <SearchableSelect
                        options={options}
                        value={undefined}
                        placeholder={`Search and add ${title.toLowerCase()}`}
                        maxVisibleItems={6}
                        closeOnSelect={true}
                        onChange={addId}
                    />
                </div>
            )}
            {currentEntityId && (
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!canAddCurrentEntity}
                    onClick={() => addId(currentEntityId)}
                >
                    {canAddCurrentEntity ? `Add Current ${setting === "ignoredGuilds" ? "Server" : "Channel"}` : `Current ${setting === "ignoredGuilds" ? "Server" : "Channel"} Already Added`}
                </Button>
            )}
            <TextInput
                value={value}
                placeholder="Comma-separated IDs"
                onChange={value => settings.store[setting] = value}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {ids.length ? ids.map(id => (
                    <span
                        key={id}
                        style={{
                            alignItems: "center",
                            background: "var(--background-tertiary)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: 999,
                            display: "inline-flex",
                            gap: 6,
                            padding: "4px 8px"
                        }}
                    >
                        <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.15 }}>
                            <BaseText size="sm" color="text-default">{labels[id]}</BaseText>
                            <BaseText size="sm" color="text-muted">{id}</BaseText>
                        </span>
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={() => removeId(id)}
                        >
                            Remove
                        </Button>
                    </span>
                )) : (
                    <BaseText size="sm" color="text-muted">No ignored IDs yet.</BaseText>
                )}
                {ids.length > 1 && (
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={() => settings.store[setting] = ""}
                    >
                        Clear All
                    </Button>
                )}
            </div>
        </section>
    );
}

function CredentialInput({
    title,
    description,
    value,
    placeholder,
    onChange,
    type = "text"
}: {
    title: string;
    description: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    type?: string;
}) {
    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>{title}</HeadingSecondary>
            <BaseText size="sm" color="text-muted" className={cl("settings-note")}>{description}</BaseText>
            <TextInput
                type={type}
                value={value}
                onChange={onChange}
                placeholder={placeholder}
            />
        </section>
    );
}

function ServiceSelect({ settings }: { settings: PluginSettingsLike; }) {
    const { service } = settings.use(SERVICE_SETTING_KEYS);
    const effectiveService = IS_WEB ? "google" : service;

    return (
        <section className={cl("setting-field")}>
            <HeadingSecondary>
                {settings.def.service.description}
            </HeadingSecondary>

            <SearchableSelect
                options={ServiceOptions}
                value={ServiceOptions.find(option => option.value === effectiveService)?.value}
                placeholder="Select a translation service"
                maxVisibleItems={4}
                closeOnSelect={true}
                onChange={value => {
                    settings.store.service = value;
                    resetLanguageDefaults();
                }}
                isDisabled={IS_WEB}
            />
        </section>
    );
}

function ServiceConfigurationSection({ settings }: { settings: PluginSettingsLike; }) {
    const { service, deeplApiKey, azureApiKey, azureRegion, azureEndpoint } = settings.use(SERVICE_CONFIG_SETTING_KEYS);
    const effectiveService = IS_WEB ? "google" : service;
    const [isTestingAzure, setIsTestingAzure] = useState(false);
    const [azureTestResult, setAzureTestResult] = useState<string>();
    const [azureTestError, setAzureTestError] = useState<string>();
    const azureTestController = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
        azureTestController.current?.abort();
        azureTestController.current = undefined;
        setIsTestingAzure(false);
        setAzureTestResult(undefined);
        setAzureTestError(undefined);

        return () => {
            const controller = azureTestController.current;
            azureTestController.current = undefined;
            controller?.abort();
        };
    }, [azureApiKey, azureEndpoint, azureRegion, service]);

    if (effectiveService === "google")
        return null;

    if (effectiveService === "deepl" || effectiveService === "deepl-pro") {
        return (
            <section className={Margins.top16}>
                <HeadingSecondary>DeepL Configuration</HeadingSecondary>
                <CredentialInput
                    title="DeepL API Key"
                    description="Used for DeepL Free or DeepL Pro requests."
                    value={deeplApiKey}
                    placeholder="Get your API key from https://deepl.com/your-account"
                    onChange={value => settings.store.deeplApiKey = value}
                />
            </section>
        );
    }

    return (
        <section className={Margins.top16}>
            <HeadingSecondary>Azure Translator Configuration</HeadingSecondary>

            <CredentialInput
                title="Azure Translator API Key"
                description="Azure Translator resource key from Azure Portal > Keys and Endpoint."
                value={azureApiKey}
                placeholder="Azure Translator API key"
                onChange={value => settings.store.azureApiKey = value}
            />

            <CredentialInput
                title="Azure Region"
                description="Required for regional or multi-service resources. Leave blank only if your Translator resource does not require a region header."
                value={azureRegion}
                placeholder="e.g. koreacentral"
                onChange={value => settings.store.azureRegion = value}
            />

            <CredentialInput
                title="Azure Endpoint"
                description="Supports the global endpoint or a custom Azure endpoint."
                value={azureEndpoint}
                placeholder="https://api.cognitive.microsofttranslator.com"
                onChange={value => settings.store.azureEndpoint = value}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: 16 }}>
                <Button
                    size="small"
                    disabled={isTestingAzure || !azureApiKey}
                    onClick={async () => {
                        azureTestController.current?.abort();
                        const controller = new AbortController();
                        azureTestController.current = controller;
                        setIsTestingAzure(true);
                        setAzureTestResult(undefined);
                        setAzureTestError(undefined);

                        try {
                            const result = await testAzureConnection(controller.signal);
                            if (controller.signal.aborted) return;

                            setAzureTestResult(`Connection OK: "${result.text}" (detected source: ${getLanguageDisplayName(result.sourceLanguage)})`);
                        } catch (error) {
                            if (!isAbortError(error))
                                setAzureTestError(normalizeTranslationFailureReason(error));
                        } finally {
                            if (azureTestController.current === controller) {
                                azureTestController.current = undefined;
                                setIsTestingAzure(false);
                            }
                        }
                    }}
                >
                    {isTestingAzure ? "Testing..." : "Test Azure Connection"}
                </Button>

                {!azureApiKey && (
                    <BaseText size="sm" color="text-muted">Set your Azure Translator API key first.</BaseText>
                )}

                {azureTestResult && (
                    <BaseText size="sm" color="text-default">{azureTestResult}</BaseText>
                )}

                {azureTestError && (
                    <BaseText size="sm" color="text-danger">{azureTestError}</BaseText>
                )}
            </div>
        </section>
    );
}

function ServiceHint({ settings }: { settings: PluginSettingsLike; }) {
    const { service } = settings.use(SERVICE_SETTING_KEYS);
    const effectiveService = IS_WEB ? "google" : service;

    if (effectiveService === "google") {
        return (
            <SectionNote>
                Google Translate works without an API key. Switching to DeepL or Azure will show the extra fields below automatically.
            </SectionNote>
        );
    }

    if (effectiveService === "deepl" || effectiveService === "deepl-pro") {
        return (
            <SectionNote>
                DeepL needs an API key. Use DeepL Free or DeepL Pro to match the key you pasted.
            </SectionNote>
        );
    }

    return (
        <SectionNote>
            Azure Translator needs an API key, and some resources also need a region and custom endpoint.
        </SectionNote>
    );
}

function formatUsageLimit(limit?: number) {
    if (limit == null || limit <= 0 || limit >= 1_000_000_000_000)
        return "No limit";

    return limit.toLocaleString();
}

function formatUsagePeriod(startTime?: string, endTime?: string) {
    if (!startTime || !endTime) return null;

    const start = new Date(startTime).toLocaleString();
    const end = new Date(endTime).toLocaleString();
    return `${start} - ${end}`;
}

function formatCacheDate(timestamp: number | null) {
    return timestamp ? new Date(timestamp).toLocaleString() : "none";
}

function DeepLUsageSection({ settings }: { settings: PluginSettingsLike; }) {
    const { service, deeplApiKey } = settings.use(DEEPL_USAGE_SETTING_KEYS);
    const effectiveService = IS_WEB ? "google" : service;
    const [isChecking, setIsChecking] = useState(false);
    const [usageSummary, setUsageSummary] = useState<string>();
    const [usagePeriod, setUsagePeriod] = useState<string>();
    const [usageError, setUsageError] = useState<string>();
    const usageController = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
        usageController.current?.abort();
        usageController.current = undefined;
        setIsChecking(false);
        setUsageSummary(undefined);
        setUsagePeriod(undefined);
        setUsageError(undefined);

        return () => {
            const controller = usageController.current;
            usageController.current = undefined;
            controller?.abort();
        };
    }, [deeplApiKey, service]);

    if (effectiveService !== "deepl" && effectiveService !== "deepl-pro")
        return null;

    return (
        <section className={Margins.top16}>
            <HeadingSecondary>DeepL Usage</HeadingSecondary>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <Button
                    size="small"
                    disabled={isChecking || !deeplApiKey}
                    onClick={async () => {
                        usageController.current?.abort();
                        const controller = new AbortController();
                        usageController.current = controller;
                        setIsChecking(true);
                        setUsageSummary(undefined);
                        setUsagePeriod(undefined);
                        setUsageError(undefined);

                        try {
                            const usage = await getDeeplUsage(controller.signal);
                            if (controller.signal.aborted) return;

                            const limit = formatUsageLimit(usage.characterLimit);
                            const apiKeyLimit = formatUsageLimit(usage.apiKeyCharacterLimit);

                            setUsageSummary(
                                usage.apiKeyCharacterCount != null
                                    ? `API key: ${usage.apiKeyCharacterCount.toLocaleString()} / ${apiKeyLimit} characters | Account: ${usage.characterCount.toLocaleString()} / ${limit} characters`
                                    : `Used ${usage.characterCount.toLocaleString()} / ${limit} characters`
                            );
                            setUsagePeriod(formatUsagePeriod(usage.startTime, usage.endTime) ?? undefined);
                        } catch (error) {
                            if (!isAbortError(error))
                                setUsageError(normalizeTranslationFailureReason(error));
                        } finally {
                            if (usageController.current === controller) {
                                usageController.current = undefined;
                                setIsChecking(false);
                            }
                        }
                    }}
                >
                    {isChecking ? "Checking..." : "Check DeepL Usage"}
                </Button>

                {!deeplApiKey && (
                    <BaseText size="sm" color="text-muted">Set your DeepL API key first.</BaseText>
                )}

                {usageSummary && (
                    <BaseText size="sm" color="text-default">{usageSummary}</BaseText>
                )}

                {usagePeriod && (
                    <BaseText size="sm" color="text-muted">Billing period: {usagePeriod}</BaseText>
                )}

                {usageError && (
                    <BaseText size="sm" color="text-danger">{usageError}</BaseText>
                )}
            </div>
        </section>
    );
}

function CurrentChannelSection({ settings }: { settings: PluginSettingsLike; }) {
    const currentChannel = useStateFromStores([SelectedChannelStore, ChannelStore], () => {
        const channelId = SelectedChannelStore.getChannelId();
        return channelId ? ChannelStore.getChannel(channelId) : null;
    });
    const {
        autoTranslate,
        autoTranslateReceived,
        receivedInput,
        receivedOutput,
        receivedChannelOverrides,
        sentChannelOverrides,
        receivedChannelInputOverrides,
        receivedChannelOutputOverrides,
        service
    } = settings.use(CURRENT_CHANNEL_SETTING_KEYS);

    const effectiveService = IS_WEB ? "google" : service;
    const normalizedReceivedInput = normalizeLanguageForService(receivedInput, effectiveService, true);
    const normalizedReceivedOutput = normalizeLanguageForService(receivedOutput, effectiveService, false);
    const languageOptions = useMemo(() => Object.entries(getLanguages()).map(([value, label]) => ({ value, label })), [service]);
    const inputOptions = useMemo(() => [{ value: "__global__", label: `Follow Global (${normalizedReceivedInput})` }, ...languageOptions], [languageOptions, normalizedReceivedInput]);
    const outputOptions = useMemo(() => [{ value: "__global__", label: `Follow Global (${normalizedReceivedOutput})` }, ...languageOptions.filter(option => option.value !== "auto")], [languageOptions, normalizedReceivedOutput]);
    if (!currentChannel?.id)
        return null;

    const channelName = currentChannel.name ? `#${currentChannel.name}` : "this channel";
    const effectiveState = getReceivedAutoTranslateChannelState(currentChannel.id, autoTranslateReceived, receivedChannelOverrides);
    const effectiveSentState = getSentAutoTranslateChannelState(currentChannel.id, autoTranslate, sentChannelOverrides);
    const effectiveInput = normalizeLanguageForService(getReceivedInputLanguageForChannel(currentChannel.id, receivedInput, receivedChannelInputOverrides), effectiveService, true);
    const effectiveOutput = normalizeLanguageForService(getReceivedOutputLanguageForChannel(currentChannel.id, receivedOutput, receivedChannelOutputOverrides), effectiveService, false);
    const hasOverride = hasReceivedAutoTranslateChannelOverride(currentChannel.id, receivedChannelOverrides);
    const hasSentOverride = hasSentAutoTranslateChannelOverride(currentChannel.id, sentChannelOverrides);
    const hasInputOverride = hasReceivedInputLanguageOverride(currentChannel.id, receivedChannelInputOverrides);
    const hasOutputOverride = hasReceivedOutputLanguageOverride(currentChannel.id, receivedChannelOutputOverrides);
    const statusSummary = hasOverride
        ? effectiveState
            ? "Forced on for this channel"
            : "Forced off for this channel"
        : `Following global default (${autoTranslateReceived ? "on" : "off"})`;
    const sentStatusSummary = hasSentOverride
        ? effectiveSentState
            ? "Forced on for this channel"
            : "Forced off for this channel"
        : `Following global default (${autoTranslate ? "on" : "off"})`;

    return (
        <section>
            <HeadingSecondary>Current Channel</HeadingSecondary>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <BaseText size="sm" color="text-default">
                    Status in {channelName}: {effectiveState ? "On" : "Off"}
                </BaseText>

                <BaseText size="sm" color="text-muted">
                    {statusSummary}
                </BaseText>

                <BaseText size="sm" color="text-default">
                    Sent auto translate here: {effectiveSentState ? "On" : "Off"}
                </BaseText>

                <BaseText size="sm" color="text-muted">
                    {sentStatusSummary}
                </BaseText>

                <BaseText size="sm" color="text-muted">
                    Languages here: {effectiveInput} → {effectiveOutput}
                </BaseText>

                <ButtonRow>
                    <Button
                        size="small"
                        variant={!hasOverride ? "primary" : "secondary"}
                        onClick={() => clearReceivedAutoTranslateChannelOverride(currentChannel.id, receivedChannelOverrides)}
                    >
                        Follow Global Default
                    </Button>

                    <Button
                        size="small"
                        variant={hasOverride && effectiveState ? "primary" : "secondary"}
                        onClick={() => setReceivedAutoTranslateChannelState(
                            currentChannel.id,
                            true,
                            autoTranslateReceived,
                            receivedChannelOverrides
                        )}
                    >
                        Force On Here
                    </Button>

                    <Button
                        size="small"
                        variant={hasOverride && !effectiveState ? "primary" : "secondary"}
                        onClick={() => setReceivedAutoTranslateChannelState(
                            currentChannel.id,
                            false,
                            autoTranslateReceived,
                            receivedChannelOverrides
                        )}
                    >
                        Force Off Here
                    </Button>
                </ButtonRow>

                <ButtonRow>
                    <Button
                        size="small"
                        variant={!hasSentOverride ? "primary" : "secondary"}
                        onClick={() => clearSentAutoTranslateChannelOverride(currentChannel.id, sentChannelOverrides)}
                    >
                        Follow Sent Global Default
                    </Button>

                    <Button
                        size="small"
                        variant={hasSentOverride && effectiveSentState ? "primary" : "secondary"}
                        onClick={() => setSentAutoTranslateChannelState(
                            currentChannel.id,
                            true,
                            autoTranslate,
                            sentChannelOverrides
                        )}
                    >
                        Force Sent On Here
                    </Button>

                    <Button
                        size="small"
                        variant={hasSentOverride && !effectiveSentState ? "primary" : "secondary"}
                        onClick={() => setSentAutoTranslateChannelState(
                            currentChannel.id,
                            false,
                            autoTranslate,
                            sentChannelOverrides
                        )}
                    >
                        Force Sent Off Here
                    </Button>
                </ButtonRow>

                <SettingsGrid>
                    <SelectSetting
                        title="Input Language For This Channel"
                        value={hasInputOverride ? effectiveInput : "__global__"}
                        options={inputOptions}
                        placeholder="Choose the source language"
                        onChange={value => value === "__global__"
                            ? clearReceivedInputLanguageOverride(currentChannel.id, receivedChannelInputOverrides)
                            : setReceivedInputLanguageForChannel(currentChannel.id, value, receivedInput, receivedChannelInputOverrides)}
                    />
                    <SelectSetting
                        title="Output Language For This Channel"
                        value={hasOutputOverride ? effectiveOutput : "__global__"}
                        options={outputOptions}
                        placeholder="Choose the target language"
                        onChange={value => value === "__global__"
                            ? clearReceivedOutputLanguageOverride(currentChannel.id, receivedChannelOutputOverrides)
                            : setReceivedOutputLanguageForChannel(currentChannel.id, value, receivedOutput, receivedChannelOutputOverrides)}
                    />
                </SettingsGrid>

                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => void clearChannelTranslationCache(currentChannel.id)}
                >
                    Clear This Channel Cache
                </Button>
            </div>
        </section>
    );
}

function isDisplayMode(value: string): value is typeof DisplayModeOptions[number]["value"] {
    return DisplayModeOptions.some(option => option.value === value);
}

function DisplayPreferencesSection({ settings }: { settings: PluginSettingsLike; }) {
    const {
        receivedDisplayMode,
        collapseTranslatedMessages
    } = settings.use(DISPLAY_SETTING_KEYS);
    const displayMode = receivedDisplayMode ?? "translated";

    return (
        <SectionCard>
            <SectionHeader eyebrow="display" title="Display preferences">
                Control how translated text appears under each message.
            </SectionHeader>
            <SettingsGrid>
                <AutoTranslateToggle settings={settings} setting="replaceMessageContent" title="Replace Message Text Directly" />
                <AutoTranslateToggle settings={settings} setting="simpleMode" title="Simple Mode" />
            </SettingsGrid>
            <SectionNote>
                Experimental. Replaces received message text with the translation and keeps only a small source-language indicator below it.
            </SectionNote>
            <SectionNote>
                Simple Mode keeps the chat clean by hiding per-message actions and showing only a short translated indicator.
            </SectionNote>
            <SelectSetting
                title="Display Mode"
                value={displayMode}
                options={DisplayModeOptions}
                placeholder="Choose how translated text is shown"
                onChange={value => {
                    if (isDisplayMode(value))
                        settings.store.receivedDisplayMode = value;
                }}
            />
            <AutoTranslateToggle settings={settings} setting="collapseTranslatedMessages" title="Collapse Translated Messages By Default" />
        </SectionCard>
    );
}

function getGoogleConfidencePreset(value: number) {
    if (value === 0.5 || value === 0.8 || value === 0.9)
        return String(value);

    return "custom";
}

function AutoSkipSection({ settings }: { settings: PluginSettingsLike; }) {
    const {
        autoTranslateMaxCharacters,
        autoTranslateMaxLines,
        googleConfidenceRequirement,
        translationCacheTtlDays,
        skipCodeBlockMessages,
        showTranslationFailureReasons
    } = settings.use(AUTO_SKIP_SETTING_KEYS);

    return (
        <SectionCard>
            <SectionHeader eyebrow="rules" title="Automatic skip rules">
                Skip long logs, code blocks, or noisy messages automatically while keeping manual translation available.
            </SectionHeader>
            <SettingsGrid>
                <NumberSetting
                    title="Maximum Characters For Automatic Translation"
                    description="Set to 0 to disable the length limit."
                    value={autoTranslateMaxCharacters}
                    onChange={value => settings.store.autoTranslateMaxCharacters = value}
                />
                <NumberSetting
                    title="Maximum Lines For Automatic Translation"
                    description="Set to 0 to disable the line limit."
                    value={autoTranslateMaxLines}
                    onChange={value => settings.store.autoTranslateMaxLines = value}
                />
            </SettingsGrid>
            <SelectSetting
                title="Google Detection Strictness"
                value={getGoogleConfidencePreset(Number(googleConfidenceRequirement) || 0)}
                options={GoogleConfidencePresetOptions}
                placeholder="Choose detection strictness"
                onChange={value => {
                    if (value !== "custom")
                        settings.store.googleConfidenceRequirement = Number(value);
                }}
            />
            <SectionNote>
                Lower values translate more messages. Higher values avoid mistaken language detection. Current value: {Number(googleConfidenceRequirement) || 0}.
            </SectionNote>
            {getGoogleConfidencePreset(Number(googleConfidenceRequirement) || 0) === "custom" && (
                <NumberSetting
                    title="Custom Google Detection Confidence"
                    description="Google only. Set to 0 to disable the confidence gate."
                    value={googleConfidenceRequirement}
                    onChange={value => settings.store.googleConfidenceRequirement = Math.min(1, value)}
                    placeholder="0 - 1"
                />
            )}
            <NumberSetting
                title="Cache Lifetime In Days"
                description="Cached translations older than this are removed automatically. Set to 0 to keep them until the cache limit or manual clear."
                value={translationCacheTtlDays}
                onChange={value => {
                    settings.store.translationCacheTtlDays = value;
                    pruneExpiredTranslationCache();
                }}
            />
            <SettingsGrid>
                <AutoTranslateToggle settings={settings} setting="skipCodeBlockMessages" title="Skip Messages That Contain Code Blocks" />
                <AutoTranslateToggle settings={settings} setting="skipAlreadyTranslatedMessages" title="Skip Messages That Already Look Translated" />
                <AutoTranslateToggle settings={settings} setting="showTranslationFailureReasons" title="Show Skip / Failure Reasons In Message Accessory" />
            </SettingsGrid>
        </SectionCard>
    );
}

function MessageFiltersSection({ settings }: { settings: PluginSettingsLike; }) {
    const currentChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());
    const currentGuildId = useStateFromStores([SelectedGuildStore], () => SelectedGuildStore.getGuildId());

    return (
        <SectionCard>
            <SectionHeader eyebrow="filters" title="Message filters">
                Keep automatic translation quiet for noisy bots, selected users, channels, or servers. Manual Translate still works.
            </SectionHeader>
            <AutoTranslateToggle settings={settings} setting="skipBotMessages" title="Skip Bot Messages" />
            <IgnoredIdListSetting
                settings={settings}
                setting="ignoredUsers"
                title="Ignored Users"
                description="User IDs that should not be auto-translated."
                currentGuildId={currentGuildId}
            />
            <IgnoredIdListSetting
                settings={settings}
                setting="ignoredChannels"
                title="Ignored Channels"
                description="Channel IDs that should not be auto-translated."
                currentEntityId={currentChannelId}
            />
            <IgnoredIdListSetting
                settings={settings}
                setting="ignoredGuilds"
                title="Ignored Servers"
                description="Server IDs that should not be auto-translated."
                currentEntityId={currentGuildId}
            />
        </SectionCard>
    );
}

function CacheSection({ settings }: { settings: PluginSettingsLike; }) {
    const {
        service,
        receivedInput,
        receivedOutput,
        receivedChannelInputOverrides,
        receivedChannelOutputOverrides,
        translationCacheTtlDays
    } = settings.use(CACHE_SETTING_KEYS);
    const currentChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());
    const [, setCacheStatsVersion] = useState(getTranslationCacheStatsVersion());

    useEffect(() => {
        return subscribeTranslationCacheStatsVersion(setCacheStatsVersion);
    }, []);

    const translationOptions = getReceivedTranslationOptionsForChannel(
        currentChannelId,
        receivedInput,
        receivedOutput,
        receivedChannelInputOverrides,
        receivedChannelOutputOverrides
    );
    const signature = getReceivedTranslationCacheSignatureFromValues(translationOptions.sourceLang, translationOptions.targetLang, service);
    const stats = getTranslationCacheStats(signature);
    const cacheLifetimeSummary = Number(translationCacheTtlDays) > 0
        ? `${translationCacheTtlDays} day${Number(translationCacheTtlDays) === 1 ? "" : "s"}`
        : "Disabled";

    return (
        <SectionCard>
            <SectionHeader eyebrow="cache" title="Cache overview" />
            <SectionNote>
                Current cache entries: {stats.count}. Matching the current received-language setup: {stats.matchingEntries}.
            </SectionNote>
            <SectionNote>
                Cache lifetime: {cacheLifetimeSummary}
            </SectionNote>
            <SectionNote>
                Last cached translation: {formatCacheDate(stats.lastUpdatedAt)}
            </SectionNote>
            <SectionNote>
                Oldest active cache: {formatCacheDate(stats.oldestUpdatedAt)}
            </SectionNote>
            <SectionNote>
                Next automatic cleanup: {formatCacheDate(stats.nextExpiresAt)}
            </SectionNote>
            <SectionNote>
                Current cache signature: {signature === stats.activeCacheSignature ? "active" : "inactive"} ({signature})
            </SectionNote>
            {stats.expiredEntries > 0 && (
                <SectionNote>
                    Expired entries waiting for cleanup: {stats.expiredEntries}.
                </SectionNote>
            )}
            <ButtonRow>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                        pruneExpiredTranslationCache();
                        setCacheStatsVersion(version => version + 1);
                    }}
                >
                    Refresh Cache Stats
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!stats.matchingEntries}
                    onClick={() => void clearTranslationCacheForSignature(signature)}
                >
                    Clear Current Language Cache
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!stats.expiredEntries}
                    onClick={() => pruneExpiredTranslationCache()}
                >
                    Clean Expired Cache
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!stats.count && !stats.expiredEntries}
                    onClick={() => void clearTranslationCache().catch(() => {
                        showToast("Failed to clear the translation cache.", Toasts.Type.FAILURE);
                    })}
                >
                    Clear All Cache
                </Button>
            </ButtonRow>
        </SectionCard>
    );
}

function SentMessagesSection({ settings }: { settings: PluginSettingsLike; }) {
    return (
        <SectionCard>
            <SectionHeader eyebrow="outgoing" title="Sent messages">
                These options apply right before your own message is sent.
            </SectionHeader>
            <SettingsGrid>
                <LanguageSelect settings={settings} settingsKey="sentInput" includeAuto={true} />
                <LanguageSelect settings={settings} settingsKey="sentOutput" includeAuto={false} />
            </SettingsGrid>
            <AutoTranslateToggle settings={settings} setting="autoTranslate" title="Auto Translate Sent Messages" />
            <AutoTranslateToggle settings={settings} setting="showAutoTranslateTooltip" title="Show Sent Auto Translate Tooltip" />
        </SectionCard>
    );
}

export function ChatTranslatorSettingsView({ settings }: { settings: PluginSettingsLike; }) {
    return (
        <>
            <SectionCard>
                <SectionHeader eyebrow="engine" title="Translation service">
                    Pick the translation engine first. API fields appear only when the selected service needs them.
                </SectionHeader>
                <ServiceSelect settings={settings} />
                <ServiceHint settings={settings} />
                <ServiceConfigurationSection settings={settings} />
                <DeepLUsageSection settings={settings} />
            </SectionCard>

            <SectionCard>
                <SectionHeader eyebrow="incoming" title="Received messages">
                    Decide how visible incoming messages are translated as they appear on screen.
                </SectionHeader>
                <SettingsGrid>
                    <LanguageSelect settings={settings} settingsKey="receivedInput" includeAuto={true} />
                    <LanguageSelect settings={settings} settingsKey="receivedOutput" includeAuto={false} />
                </SettingsGrid>
                <AutoTranslateToggle settings={settings} setting="autoTranslateReceived" title="Auto Translate Received Messages" />
            </SectionCard>

            <SentMessagesSection settings={settings} />

            <DisplayPreferencesSection settings={settings} />

            <SectionCard>
                <CurrentChannelSection settings={settings} />
            </SectionCard>

            <MessageFiltersSection settings={settings} />

            <AutoSkipSection settings={settings} />

            <CacheSection settings={settings} />
        </>
    );
}
