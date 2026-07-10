/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isObject } from "@utils/misc";
import { IpcMainInvokeEvent, net } from "electron";

const MAX_SECRET_LENGTH = 1_024;
const MAX_TRANSLATE_PAYLOAD_LENGTH = 32_000;
const MAX_RESPONSE_LENGTH = 1_000_000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ACTIVE_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 30_000;
const ActiveRequests = new Map<string, { controller: AbortController; senderId: number; }>();

function getActiveRequestKey(event: IpcMainInvokeEvent, requestId: string) {
    return `${event.sender.id}:${requestId}`;
}

function scrubError(error: unknown) {
    return error instanceof Error && error.name === "AbortError"
        ? "Request cancelled."
        : "Request failed.";
}

function isValidSecret(value: unknown) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= MAX_SECRET_LENGTH
        && !/[\r\n]/.test(value);
}

function isValidPayload(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_TRANSLATE_PAYLOAD_LENGTH;
}

function parsePayload(value: unknown) {
    if (!isValidPayload(value)) return null;

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function isValidDeeplPayload(value: unknown) {
    const payload = parsePayload(value);
    if (!isObject(payload)
        || !("text" in payload)
        || !Array.isArray(payload.text)
        || payload.text.length !== 1
        || typeof payload.text[0] !== "string"
        || !("target_lang" in payload)
        || typeof payload.target_lang !== "string"
        || payload.target_lang.length > 32
        || ("source_lang" in payload && payload.source_lang != null && (typeof payload.source_lang !== "string" || payload.source_lang.length > 32)))
        return false;

    return Object.keys(payload).every(key => key === "text" || key === "target_lang" || key === "source_lang");
}

function isValidAzurePayload(value: unknown) {
    const payload = parsePayload(value);
    if (!Array.isArray(payload) || payload.length !== 1 || !isObject(payload[0])) return false;

    return Object.keys(payload[0]).length === 1
        && "Text" in payload[0]
        && typeof payload[0].Text === "string";
}

function isValidRequestId(value: unknown) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}

function validateAzureTranslatorUrl(value: unknown) {
    if (typeof value !== "string" || value.length > 2_048)
        return null;

    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
        const isAllowedHost = hostname === "api.cognitive.microsofttranslator.com"
            || hostname.endsWith(".cognitiveservices.azure.com")
            || hostname.endsWith(".api.cognitive.microsofttranslator.com");
        const isAllowedPath = pathname === "/translate"
            || pathname.endsWith("/translator/text/v3.0/translate");
        const hasAllowedParameters = url.searchParams.get("api-version") === "3.0"
            && url.searchParams.getAll("to").length === 1
            && Array.from(url.searchParams.keys()).every(key => key === "api-version" || key === "from" || key === "to");

        if (url.protocol !== "https:"
            || url.port
            || url.username
            || url.password
            || url.hash
            || !isAllowedHost
            || !isAllowedPath
            || !hasAllowedParameters)
            return null;

        return url.toString();
    } catch {
        return null;
    }
}

async function readResponseText(response: Response) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
        await response.body?.cancel();
        throw new Error("Response is too large.");
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
            if (receivedLength > MAX_RESPONSE_LENGTH) {
                await reader.cancel();
                throw new Error("Response is too large.");
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString("utf8");
}

async function performRequest(event: IpcMainInvokeEvent, requestId: string, url: string, method: "GET" | "POST", headers: Record<string, string>, payload?: string) {
    const requestKey = getActiveRequestKey(event, requestId);
    if (ActiveRequests.has(requestKey))
        return { status: -1, data: "Duplicate request." };
    if (ActiveRequests.size >= MAX_ACTIVE_REQUESTS)
        return { status: -1, data: "Too many active requests." };

    const controller = new AbortController();
    const activeRequest = { controller, senderId: event.sender.id };
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    ActiveRequests.set(requestKey, activeRequest);

    try {
        const body = payload ? Buffer.from(payload, "utf8") : undefined;
        const response = await net.fetch(url, {
            method,
            headers,
            redirect: "error",
            signal: controller.signal,
            ...(body ? { body } : {})
        });

        return {
            status: response.status,
            data: await readResponseText(response)
        };
    } catch (e) {
        return { status: -1, data: scrubError(e) };
    } finally {
        clearTimeout(timeout);
        if (ActiveRequests.get(requestKey) === activeRequest)
            ActiveRequests.delete(requestKey);
    }
}

export function cancelRequest(event: IpcMainInvokeEvent, requestId: string) {
    if (!isValidRequestId(requestId)) return false;

    const requestKey = getActiveRequestKey(event, requestId);
    const activeRequest = ActiveRequests.get(requestKey);
    if (!activeRequest || activeRequest.senderId !== event.sender.id) return false;

    activeRequest.controller.abort();
    ActiveRequests.delete(requestKey);
    return true;
}

export async function makeDeeplTranslateRequest(event: IpcMainInvokeEvent, pro: boolean, apiKey: string, payload: string, requestId: string) {
    if (typeof pro !== "boolean" || !isValidSecret(apiKey) || !isValidDeeplPayload(payload) || !isValidRequestId(requestId))
        return { status: -1, data: "Invalid DeepL request." };

    const url = pro
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    return performRequest(event, requestId, url, "POST", {
        "Content-Type": "application/json",
        "Authorization": `DeepL-Auth-Key ${apiKey}`
    }, payload);
}

export async function makeDeeplUsageRequest(event: IpcMainInvokeEvent, pro: boolean, apiKey: string, requestId: string) {
    if (typeof pro !== "boolean" || !isValidSecret(apiKey) || !isValidRequestId(requestId))
        return { status: -1, data: "Invalid DeepL usage request." };

    const url = pro
        ? "https://api.deepl.com/v2/usage"
        : "https://api-free.deepl.com/v2/usage";

    return performRequest(event, requestId, url, "GET", {
        "Content-Type": "application/json",
        "Authorization": `DeepL-Auth-Key ${apiKey}`
    });
}

export async function makeAzureTranslateRequest(
    event: IpcMainInvokeEvent,
    url: string,
    apiKey: string,
    region: string,
    payload: string,
    requestId: string
) {
    const safeUrl = validateAzureTranslatorUrl(url);
    if (!safeUrl
        || !isValidSecret(apiKey)
        || typeof region !== "string"
        || region.length > 128
        || (region && !/^[a-z0-9-]+$/i.test(region))
        || !isValidAzurePayload(payload)
        || !isValidRequestId(requestId))
        return { status: -1, data: "Invalid Azure Translator request." };

    return performRequest(event, requestId, safeUrl, "POST", {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": apiKey,
        ...(region ? { "Ocp-Apim-Subscription-Region": region } : {})
    }, payload);
}
