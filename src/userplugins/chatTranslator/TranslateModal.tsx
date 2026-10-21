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
import { HeadingPrimary, HeadingSecondary } from "@components/Heading";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, useEffect, useRef, useState } from "@webpack/common";

import { settings } from "./settings";
import { ChatTranslatorSettingsView } from "./SettingsView";
import { clearTranslationCache } from "./TranslationAccessory";
import { cl } from "./utils";

function CacheSection() {
    const [isClearing, setIsClearing] = useState(false);
    const [cacheMessage, setCacheMessage] = useState<string>();
    const [cacheError, setCacheError] = useState<string>();
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    return (
        <section className={Margins.top16}>
            <HeadingSecondary>Cache</HeadingSecondary>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <BaseText size="sm" color="text-muted">
                    Clears cached translations, dismissed states, and pending translation state for fresh testing.
                </BaseText>

                <Button
                    size="small"
                    variant="secondary"
                    disabled={isClearing}
                    onClick={async () => {
                        setIsClearing(true);
                        setCacheMessage(undefined);
                        setCacheError(undefined);

                        try {
                            await clearTranslationCache();
                            if (mounted.current)
                                setCacheMessage("Translation cache cleared.");
                        } catch {
                            if (mounted.current)
                                setCacheError("Failed to clear the translation cache.");
                        } finally {
                            if (mounted.current)
                                setIsClearing(false);
                        }
                    }}
                >
                    {isClearing ? "Clearing..." : "Clear Translation Cache"}
                </Button>

                {cacheMessage && (
                    <BaseText size="sm" color="text-default">{cacheMessage}</BaseText>
                )}

                {cacheError && (
                    <BaseText size="sm" color="text-danger">{cacheError}</BaseText>
                )}
            </div>
        </section>
    );
}

export function TranslateModal({ rootProps }: { rootProps: RenderModalProps; }) {
    return (
        <Modal
            {...rootProps}
            title={<HeadingPrimary className={cl("modal-title")}>Chat Translator Quick Settings</HeadingPrimary>}
            size="lg"
        >
            <div className={cl("modal-content")}>
                <ChatTranslatorSettingsView settings={settings} />
                <CacheSection />
            </div>
        </Modal>
    );
}
