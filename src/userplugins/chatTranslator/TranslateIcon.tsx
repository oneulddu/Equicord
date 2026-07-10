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

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { Paragraph } from "@components/Paragraph";
import { TooltipContainer } from "@components/TooltipContainer";
import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import { IconComponent } from "@utils/types";
import { Alerts, SelectedChannelStore, useEffect, useState, useStateFromStores } from "@webpack/common";

import {
    getSentAutoTranslateChannelState,
    hasSentAutoTranslateChannelOverride,
    isManualTranslateNextSendEnabled,
    setSentAutoTranslateChannelState,
    subscribeManualTranslateNextSend,
    toggleManualTranslateNextSend
} from "./sentTranslation";
import { settings } from "./settings";
import { TranslateModal } from "./TranslateModal";
import { cl, getReceivedAutoTranslateChannelState, hasReceivedAutoTranslateChannelOverride, setReceivedAutoTranslateChannelState } from "./utils";

const CHAT_BAR_SETTING_KEYS: Array<keyof typeof settings.store> = ["autoTranslate", "autoTranslateReceived", "receivedChannelOverrides", "sentChannelOverrides", "showAutoTranslateAlert", "showAutoTranslateTooltip"];

export const TranslateIcon: IconComponent = ({ height = 20, width = 20, className }) => {
    return (
        <svg
            viewBox="0 96 960 960"
            height={height}
            width={width}
            className={classes(cl("icon"), className)}
        >
            <path fill="currentColor" d="m475 976 181-480h82l186 480h-87l-41-126H604l-47 126h-82Zm151-196h142l-70-194h-2l-70 194Zm-466 76-55-55 204-204q-38-44-67.5-88.5T190 416h87q17 33 37.5 62.5T361 539q45-47 75-97.5T487 336H40v-80h280v-80h80v80h280v80H567q-22 69-58.5 135.5T419 598l98 99-30 81-127-122-200 200Z" />
        </svg>
    );
};

export let setTemporaryChatTranslatorTooltip: undefined | ((text: string | null) => void);

function MainTranslateChatBarIcon() {
    const { autoTranslate, autoTranslateReceived, receivedChannelOverrides, sentChannelOverrides } = settings.use(CHAT_BAR_SETTING_KEYS);
    const currentChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());
    const [manualNextSend, setManualNextSendState] = useState(isManualTranslateNextSendEnabled);
    const isReceivedAutoTranslateEnabled = getReceivedAutoTranslateChannelState(currentChannelId, autoTranslateReceived, receivedChannelOverrides);
    const isSentAutoTranslateEnabled = getSentAutoTranslateChannelState(currentChannelId, autoTranslate, sentChannelOverrides);
    const hasCurrentReceivedChannelOverride = hasReceivedAutoTranslateChannelOverride(currentChannelId, receivedChannelOverrides);
    const hasCurrentSentChannelOverride = hasSentAutoTranslateChannelOverride(currentChannelId, sentChannelOverrides);

    const [temporaryTooltipText, setTemporaryTooltipText] = useState<string | null>(null);
    useEffect(() => {
        setTemporaryChatTranslatorTooltip = setTemporaryTooltipText;
        return () => {
            if (setTemporaryChatTranslatorTooltip === setTemporaryTooltipText)
                setTemporaryChatTranslatorTooltip = undefined;
        };
    }, []);

    useEffect(() => {
        return subscribeManualTranslateNextSend(setManualNextSendState);
    }, []);

    const toggleSentAutoTranslate = () => {
        const newState = !isSentAutoTranslateEnabled;

        if (currentChannelId) {
            setSentAutoTranslateChannelState(currentChannelId, newState, autoTranslate, sentChannelOverrides);
            return;
        }

        settings.store.autoTranslate = newState;
        if (newState && settings.store.showAutoTranslateAlert !== false)
            Alerts.show({
                title: "Chat Translator Sent Messages Enabled",
                body: <>
                    <Paragraph>
                        Sent auto translate is enabled. Any message <b>will automatically be translated</b> before being sent.
                    </Paragraph>
                </>,
                confirmText: "Disable Auto-Translate",
                cancelText: "Got it",
                secondaryConfirmText: "Don't show again",
                onConfirmSecondary: () => settings.store.showAutoTranslateAlert = false,
                onConfirm: () => settings.store.autoTranslate = false,
            });
    };

    const toggleManualNextSend = () => {
        toggleManualTranslateNextSend();
    };

    const toggleReceivedAutoTranslate = () => {
        if (!currentChannelId) {
            settings.store.autoTranslateReceived = !autoTranslateReceived;
            return;
        }

        setReceivedAutoTranslateChannelState(
            currentChannelId,
            !isReceivedAutoTranslateEnabled,
            autoTranslateReceived,
            receivedChannelOverrides
        );
    };

    const button = (
        <ChatBarButton
            tooltip={
                currentChannelId
                    ? `${hasCurrentReceivedChannelOverride
                        ? `Received Auto Translate is ${isReceivedAutoTranslateEnabled ? "On" : "Off"} here (channel override)`
                        : `Received Auto Translate is ${isReceivedAutoTranslateEnabled ? "On" : "Off"} here (following global default)`
                    }\n${hasCurrentSentChannelOverride
                        ? `Sent Auto Translate is ${isSentAutoTranslateEnabled ? "On" : "Off"} here (channel override)`
                        : `Sent Auto Translate is ${isSentAutoTranslateEnabled ? "On" : "Off"} here (following global default)`
                    }\nLeft click changes received translation here. Shift+click toggles sent auto translate. Alt+click translates the next message once. Right click opens quick settings.`
                    : `Received Auto Translate is ${autoTranslateReceived ? "On" : "Off"} globally\nSent Auto Translate is ${autoTranslate ? "On" : "Off"} globally\nShift+click toggles sent auto translate. Alt+click translates the next message once. Right click opens quick settings.`
            }
            onClick={e => {
                if (e.altKey) return toggleManualNextSend();
                if (e.shiftKey) return toggleSentAutoTranslate();
                toggleReceivedAutoTranslate();
            }}
            onContextMenu={e => {
                e.preventDefault();
                openModal(props => (
                    <TranslateModal rootProps={props} />
                ));
            }}
            buttonProps={{
                "aria-haspopup": "dialog"
            }}
        >
            <span className={cl("chat-button-wrap", isSentAutoTranslateEnabled ? "sent-auto-translate" : undefined)}>
                <TranslateIcon className={cl({ "auto-translate": isReceivedAutoTranslateEnabled, "chat-button": true })} />
                {manualNextSend && <span className={cl("manual-next-badge")}>1x</span>}
            </span>
        </ChatBarButton>
    );

    if (temporaryTooltipText && settings.store.showAutoTranslateTooltip)
        return (
            <TooltipContainer text={temporaryTooltipText} forceOpen>
                {button}
            </TooltipContainer>
        );

    return button;
}

export const TranslateChatBarIcon: ChatBarButtonFactory = ({ isMainChat }) => isMainChat
    ? <MainTranslateChatBarIcon />
    : null;
