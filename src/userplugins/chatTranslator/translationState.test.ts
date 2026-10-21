/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
    clearTranslationRequests,
    containsCodeFence,
    createTranslationCacheSignature,
    isAbortError,
    isSameTranslationRequest,
    queueTranslationRequest,
    runLimitedTranslation,
    type TranslationRequestIdentity
} from "./translationState";

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>(resolvePromise => resolve = resolvePromise);
    return { promise, resolve };
}

function flushPromises() {
    return new Promise<void>(resolve => setImmediate(resolve));
}

const BaseRequest: TranslationRequestIdentity = {
    cacheSignature: "v2::google::auto::en",
    channelId: "channel",
    content: "hello",
    messageId: "message",
    requestSignature: "google"
};

afterEach(() => {
    clearTranslationRequests(true);
});

test("cache signatures change with the translation service", () => {
    assert.notEqual(
        createTranslationCacheSignature("google", "auto", "en"),
        createTranslationCacheSignature("deepl", "auto", "en")
    );
    assert.notEqual(
        createTranslationCacheSignature("deepl", "auto", "en-us"),
        createTranslationCacheSignature("deepl", "auto", "en-gb")
    );
    assert.notEqual(
        createTranslationCacheSignature("deepl", "auto", "pt-br"),
        createTranslationCacheSignature("deepl", "auto", "pt-pt")
    );
});

test("unfinished fenced code blocks are detected", () => {
    assert.equal(containsCodeFence("```ts\nconst greeting = 'hello';"), true);
});

test("request identity includes channel and settings", () => {
    assert.equal(isSameTranslationRequest(BaseRequest, { ...BaseRequest }), true);
    assert.equal(isSameTranslationRequest(BaseRequest, { ...BaseRequest, channelId: "other" }), false);
    assert.equal(isSameTranslationRequest(BaseRequest, { ...BaseRequest, requestSignature: "azure" }), false);
});

test("identical pending requests are deduplicated", async () => {
    const result = deferred<string>();
    let runs = 0;
    let resolved = 0;
    const task = () => {
        runs++;
        return result.promise;
    };
    const callbacks = {
        onError: () => assert.fail("The request should not fail"),
        onResolve: () => resolved++,
        onSettled: () => undefined
    };

    assert.equal(queueTranslationRequest(BaseRequest, task, callbacks), true);
    assert.equal(queueTranslationRequest(BaseRequest, task, callbacks), false);
    await flushPromises();
    assert.equal(runs, 1);

    result.resolve("translated");
    await flushPromises();
    assert.equal(resolved, 1);
});

test("an older response cannot replace a newer request", async () => {
    const oldResult = deferred<string>();
    const newResult = deferred<string>();
    const applied: string[] = [];

    queueTranslationRequest(BaseRequest, () => oldResult.promise, {
        onError: () => assert.fail("The old request should be ignored"),
        onResolve: value => applied.push(value),
        onSettled: () => undefined
    });
    queueTranslationRequest({ ...BaseRequest, requestSignature: "new" }, () => newResult.promise, {
        onError: () => assert.fail("The new request should not fail"),
        onResolve: value => applied.push(value),
        onSettled: () => undefined
    });

    newResult.resolve("new");
    await flushPromises();
    oldResult.resolve("old");
    await flushPromises();

    assert.deepEqual(applied, ["new"]);
});

test("clearing requests aborts active work and ignores its result", async () => {
    const result = deferred<string>();
    let requestSignal: AbortSignal | undefined;
    let resolved = false;

    queueTranslationRequest(BaseRequest, signal => {
        requestSignal = signal;
        return result.promise;
    }, {
        onError: () => assert.fail("Cancelled requests should not report failures"),
        onResolve: () => resolved = true,
        onSettled: () => undefined
    });
    await flushPromises();

    clearTranslationRequests();
    assert.equal(requestSignal?.aborted, true);
    result.resolve("late");
    await flushPromises();

    assert.equal(resolved, false);
});

test("a cancelled queued translation is removed before it can run", async () => {
    const blockers = Array.from({ length: 4 }, () => deferred<string>());
    const blockerControllers = blockers.map(() => new AbortController());
    let activeRuns = 0;
    const blockerPromises = blockers.map((blocker, index) => runLimitedTranslation(
        blockerControllers[index].signal,
        async () => {
            activeRuns++;
            return blocker.promise;
        }
    ));
    await flushPromises();
    assert.equal(activeRuns, 4);

    const cancelledController = new AbortController();
    let cancelledRan = false;
    const cancelledPromise = runLimitedTranslation(cancelledController.signal, async () => {
        cancelledRan = true;
        return "cancelled";
    }).catch(error => {
        assert.equal(isAbortError(error), true);
    });

    const nextResult = deferred<string>();
    let nextRan = false;
    const nextPromise = runLimitedTranslation(new AbortController().signal, async () => {
        nextRan = true;
        return nextResult.promise;
    });

    cancelledController.abort();
    blockers[0].resolve("first");
    await flushPromises();

    assert.equal(cancelledRan, false);
    assert.equal(nextRan, true);

    nextResult.resolve("next");
    for (const blocker of blockers.slice(1))
        blocker.resolve("done");

    await Promise.all([...blockerPromises, cancelledPromise, nextPromise]);
});
