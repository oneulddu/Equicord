/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeLanguageForService } from "./languageOverrides";

Object.defineProperty(globalThis, "IS_WEB", { configurable: true, value: false });

test("valid DeepL target dialects are preserved", () => {
    assert.equal(normalizeLanguageForService("en-gb", "deepl", false), "en-gb");
    assert.equal(normalizeLanguageForService("pt-pt", "deepl-pro", false), "pt-pt");
});

test("languages are converted only when changing service vocabularies", () => {
    assert.equal(normalizeLanguageForService("en-gb", "google", false), "en");
    assert.equal(normalizeLanguageForService("en", "deepl", false), "en-us");
});
