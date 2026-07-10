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

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import type { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";

import { startTranslationCache, stopTranslationCache } from "./cache";
import { clearLanguageOverrideCaches } from "./languageOverrides";
import { clearSentAutoTranslateChannelOverride, getSentAutoTranslateChannelState, hasSentAutoTranslateChannelOverride, setSentAutoTranslateChannelState, stopSentTranslation, translateOutgoingMessage } from "./sentTranslation";
import { settings } from "./settings";
import { setTemporaryChatTranslatorTooltip, TranslateChatBarIcon, TranslateIcon } from "./TranslateIcon";
import { clearChannelTranslationCache, getReplacedMessageContent, getReplacedMessageSourceLanguage, startTranslationRuntime, stopTranslationRuntime, translateMessageManually, TranslationAccessory } from "./TranslationAccessory";
import {
    cl,
    clearReceivedAutoTranslateChannelOverride,
    clearReceivedInputLanguageOverride,
    clearReceivedOutputLanguageOverride,
    clearTranslationUtilityCaches,
    getMessageChannelId,
    getMessageContent,
    getReceivedAutoTranslateChannelState,
    hasMeaningfulTextForTranslation,
    hasReceivedAutoTranslateChannelOverride,
    isIgnoredChannel,
    isIgnoredGuild,
    isIgnoredUser,
    setIgnoredChannel,
    setIgnoredGuild,
    setIgnoredUser,
    setReceivedAutoTranslateChannelState,
    setReceivedOutputLanguageForChannel,
    stopStandaloneTranslationRequests,
    translate
} from "./utils";

let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

const PLUGIN_VERSION = "1.0.0";
const PLUGIN_MAINTAINER = "oneulffu";
const SafeTranslationAccessory = ErrorBoundary.wrap(TranslationAccessory, { noop: true });
const SafeTranslateChatBarIcon = ErrorBoundary.wrap(TranslateChatBarIcon, { noop: true });

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content || !hasMeaningfulTextForTranslation(content)) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    const insertAt = group.findIndex(c => c?.props?.id === "copy-text") + 1;
    const authorId = message.author?.id;

    group.splice(insertAt, 0,
        <Menu.MenuItem
            id="chat-translator-message"
            label="Translate"
            icon={TranslateIcon}
            action={() => translateMessageManually(message, content)}
        />,
        authorId ? (
            <Menu.MenuItem
                id="chat-translator-ignore-user"
                label={isIgnoredUser(authorId) ? "Auto Translate This User Again" : "Ignore This User for Auto Translate"}
                action={() => setIgnoredUser(authorId, !isIgnoredUser(authorId))}
            />
        ) : null
    );
};

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel, thread }: { channel?: Channel; thread?: Channel; }) => {
    const targetChannel = thread ?? channel;
    if (!targetChannel?.id) return;

    const channelId = targetChannel.id;
    const { autoTranslateReceived, receivedChannelOverrides } = settings.store;
    const { autoTranslate, sentChannelOverrides } = settings.store;
    const effectiveState = getReceivedAutoTranslateChannelState(channelId, autoTranslateReceived, receivedChannelOverrides);
    const effectiveSentState = getSentAutoTranslateChannelState(channelId, autoTranslate, sentChannelOverrides);
    const hasOverride = hasReceivedAutoTranslateChannelOverride(channelId, receivedChannelOverrides);
    const hasSentOverride = hasSentAutoTranslateChannelOverride(channelId, sentChannelOverrides);
    const group = `chat-translator-${channelId}`;
    const sentGroup = `chat-translator-sent-${channelId}`;
    const guildId = targetChannel.guild_id;

    children.push(
        <Menu.MenuItem
            id={`chat-translator-${channelId}`}
            label="Auto Translate"
        >
            <Menu.MenuRadioItem
                id={`chat-translator-${channelId}-global`}
                group={group}
                label={`Use Global Default (${autoTranslateReceived ? "On" : "Off"})`}
                checked={!hasOverride}
                action={() => clearReceivedAutoTranslateChannelOverride(channelId, receivedChannelOverrides)}
            />
            <Menu.MenuRadioItem
                id={`chat-translator-${channelId}-enable`}
                group={group}
                label="Always On In This Channel"
                checked={hasOverride && effectiveState}
                action={() => setReceivedAutoTranslateChannelState(channelId, true, autoTranslateReceived, receivedChannelOverrides)}
            />
            <Menu.MenuRadioItem
                id={`chat-translator-${channelId}-disable`}
                group={group}
                label="Always Off In This Channel"
                checked={hasOverride && !effectiveState}
                action={() => setReceivedAutoTranslateChannelState(channelId, false, autoTranslateReceived, receivedChannelOverrides)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-toggle-quick`}
                label={effectiveState ? "Turn Off In This Channel" : "Turn On In This Channel"}
                action={() => setReceivedAutoTranslateChannelState(channelId, !effectiveState, autoTranslateReceived, receivedChannelOverrides)}
            />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-ko`}
                label="Translate This Channel to Korean"
                action={() => {
                    setReceivedAutoTranslateChannelState(channelId, true, autoTranslateReceived, receivedChannelOverrides);
                    setReceivedOutputLanguageForChannel(
                        channelId,
                        "ko",
                        settings.store.receivedOutput,
                        settings.store.receivedChannelOutputOverrides
                    );
                }}
            />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-reset-lang`}
                label="Follow Global Channel Languages"
                action={() => {
                    clearReceivedInputLanguageOverride(channelId, settings.store.receivedChannelInputOverrides);
                    clearReceivedOutputLanguageOverride(channelId, settings.store.receivedChannelOutputOverrides);
                }}
            />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-clear-cache`}
                label="Clear This Channel Cache"
                action={() => void clearChannelTranslationCache(channelId)}
            />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-sent-auto`}
                label="Sent Auto Translate"
            >
                <Menu.MenuRadioItem
                    id={`chat-translator-${channelId}-sent-global`}
                    group={sentGroup}
                    label={`Use Global Default (${autoTranslate ? "On" : "Off"})`}
                    checked={!hasSentOverride}
                    action={() => clearSentAutoTranslateChannelOverride(channelId, sentChannelOverrides)}
                />
                <Menu.MenuRadioItem
                    id={`chat-translator-${channelId}-sent-enable`}
                    group={sentGroup}
                    label="Always On In This Channel"
                    checked={hasSentOverride && effectiveSentState}
                    action={() => setSentAutoTranslateChannelState(channelId, true, autoTranslate, sentChannelOverrides)}
                />
                <Menu.MenuRadioItem
                    id={`chat-translator-${channelId}-sent-disable`}
                    group={sentGroup}
                    label="Always Off In This Channel"
                    checked={hasSentOverride && !effectiveSentState}
                    action={() => setSentAutoTranslateChannelState(channelId, false, autoTranslate, sentChannelOverrides)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id={`chat-translator-${channelId}-sent-toggle-quick`}
                    label={effectiveSentState ? "Turn Off Sent Auto Translate Here" : "Turn On Sent Auto Translate Here"}
                    action={() => setSentAutoTranslateChannelState(channelId, !effectiveSentState, autoTranslate, sentChannelOverrides)}
                />
            </Menu.MenuItem>
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id={`chat-translator-${channelId}-ignore-channel`}
                label={isIgnoredChannel(channelId) ? "Auto Translate This Channel Again" : "Ignore This Channel"}
                action={() => setIgnoredChannel(channelId, !isIgnoredChannel(channelId))}
            />
            {guildId && (
                <Menu.MenuItem
                    id={`chat-translator-${channelId}-ignore-guild`}
                    label={isIgnoredGuild(guildId) ? "Auto Translate This Server Again" : "Ignore This Server"}
                    action={() => setIgnoredGuild(guildId, !isIgnoredGuild(guildId))}
                />
            )}
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "ChatTranslator",
    description: "Translate messages using DeepL or Google Translate, with optional auto-translation for received and sent messages.",
    authors: [{ name: PLUGIN_MAINTAINER, id: 0n }],
    settings,
    translate,
    patches: [
        {
            find: '.CUSTOM_GIFT?""',
            group: true,
            replacement: [
                {
                    match: /message:(\i),message:\{id:\i\}.{0,200}renderContentOnly:\i.{0,30}\}=\i;/,
                    replace: "$&$1=$self.transformMessage($1);",
                },
                {
                    match: /childrenMessageContent:(\i),/g,
                    replace: "childrenMessageContent:$self.wrapContent($1,arguments[0].message.id),",
                },
            ],
        },
    ],

    settingsAboutComponent: () => (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <BaseText size="sm" color="text-default">Version: {PLUGIN_VERSION}</BaseText>
            <BaseText size="sm" color="text-default">Maintainer: {PLUGIN_MAINTAINER}</BaseText>
            <BaseText size="sm" color="text-muted">Plugin ID: ChatTranslator</BaseText>
        </div>
    ),

    transformMessage(message: Message) {
        return getReplacedMessageContent(message);
    },

    wrapContent(content: React.ReactNode, messageId: string) {
        const sourceLanguage = getReplacedMessageSourceLanguage(messageId);
        if (!sourceLanguage) return content;

        return (
            <>
                {content}
                <div className={cl("replaced-indicator")}>translated from {sourceLanguage}</div>
            </>
        );
    },

    renderMessageAccessory: props => <SafeTranslationAccessory message={props.message} />,

    chatBarButton: {
        icon: TranslateIcon,
        render: props => <SafeTranslateChatBarIcon {...props} />
    },
    contextMenus: {
        message: patchMessageContextMenu,
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu
    },
    messagePopoverButton: {
        icon: TranslateIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content || !hasMeaningfulTextForTranslation(content)) return null;

            return {
                label: "Translate",
                icon: TranslateIcon,
                message,
                channel: ChannelStore.getChannel(getMessageChannelId(message)),
                onClick: () => translateMessageManually(message, content)
            };
        }
    },

    start() {
        startTranslationCache();
        startTranslationRuntime();

        if (!settings.store.inlineReplacementMigrationDone) {
            settings.store.replaceMessageContent = true;
            settings.store.inlineReplacementMigrationDone = true;
        }
    },

    stop() {
        stopSentTranslation();
        stopStandaloneTranslationRequests();
        stopTranslationRuntime();
        stopTranslationCache();
        clearLanguageOverrideCaches();
        clearTranslationUtilityCaches();
        setTemporaryChatTranslatorTooltip?.(null);
        if (!tooltipTimeout) return;

        clearTimeout(tooltipTimeout);
        tooltipTimeout = undefined;
    },

    async onBeforeMessageSend(channelId, message) {
        if (!message.content) return;

        const translatedText = await translateOutgoingMessage(channelId, message.content);
        if (!translatedText) return;

        message.content = translatedText;

        if (settings.store.showAutoTranslateTooltip) {
            setTemporaryChatTranslatorTooltip?.("Outgoing message translated.");
            if (tooltipTimeout)
                clearTimeout(tooltipTimeout);

            tooltipTimeout = setTimeout(() => setTemporaryChatTranslatorTooltip?.(null), 2000);
        }
    }
});
