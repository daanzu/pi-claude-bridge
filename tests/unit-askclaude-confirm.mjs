import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await tick();
	}
	assert.fail(message);
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function context(confirm, { hasUI = true, cwd = "/work/project" } = {}) {
	return {
		hasUI,
		cwd,
		ui: { confirm },
		model: { baseUrl: "another-provider" },
		getSystemPrompt: () => "system prompt",
		sessionManager: { getBranch: () => [] },
	};
}

function settings(overrides = {}) {
	return {
		defaultMode: "read",
		defaultIsolated: true,
		confirmBeforeSpawn: true,
		...overrides,
	};
}

const successRunner = (calls, responseText = "answer") => async (...args) => {
	calls.push(args);
	return { responseText, stopReason: "stop" };
};

function execute(params, ctx, runner, signal, overrides) {
	return __test.executeAskClaude(
		{ prompt: "inspect this", ...params },
		signal,
		undefined,
		ctx,
		settings(overrides),
		runner,
	);
}

describe("AskClaude spawn confirmation", { concurrency: false }, () => {
	it("classifies cancelled results separately from success and Claude Code errors", () => {
		assert.equal(__test.askClaudeResultKind({ cancelled: true }), "cancelled");
		assert.equal(__test.askClaudeResultKind({ error: true }), "error");
		assert.equal(__test.askClaudeResultKind({}), "success");
	});

	it("attributes the child query usage to the parent tool result", async () => {
		const usage = {
			input: 11,
			output: 7,
			cacheRead: 13,
			cacheWrite: 5,
			totalTokens: 36,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
		};
		const result = await execute(
			{},
			context(async () => true),
			async () => ({ responseText: "answer", stopReason: "stop", usage }),
		);

		assert.strictEqual(result.usage, usage);
	});

	it("retains usage when the child query fails after being billed", async () => {
		const usage = {
			input: 11,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.1, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.11 },
		};
		const runner = async () => {
			throw Object.assign(new Error("child failed"), { usage });
		};
		const result = await execute({}, context(async () => true), runner);

		assert.equal(result.details.error, true);
		assert.strictEqual(result.usage, usage);
	});

	it("does not prompt when the option is omitted/false and retains the existing execution path", async () => {
		let confirms = 0;
		const calls = [];
		const result = await execute(
			{},
			context(async () => { confirms++; return false; }),
			successRunner(calls),
			undefined,
			{ confirmBeforeSpawn: false },
		);

		assert.equal(confirms, 0);
		assert.equal(calls.length, 1);
		assert.equal(result.content[0].text, "answer");
		assert.equal(result.details.cancelled, undefined);
	});

	it("does not start the progress timer while confirmation is pending", async () => {
		const dialog = deferred();
		const calls = [];
		let timerStarts = 0;
		const originalSetInterval = globalThis.setInterval;
		try {
			globalThis.setInterval = () => {
				timerStarts++;
				return undefined;
			};
			const resultPromise = execute({}, context(() => dialog.promise), successRunner(calls));
			await tick();
			assert.equal(timerStarts, 0);
			assert.equal(calls.length, 0);

			dialog.resolve(true);
			await resultPromise;
			assert.equal(timerStarts, 1);
			assert.equal(calls.length, 1);
		} finally {
			globalThis.setInterval = originalSetInterval;
		}
	});

	it("shows fixed, delimited details and starts the query only after approval", async () => {
		const calls = [];
		let seen;
		const signal = new AbortController().signal;
		const result = await execute(
			{ prompt: "line one\nline two", mode: "full", model: undefined, isolated: false },
			context(async (title, message, options) => {
				seen = { title, message, options };
				assert.equal(calls.length, 0, "the runner must not start before approval");
				return true;
			}),
			successRunner(calls),
			signal,
		);

		assert.equal(seen.title, "Run AskClaude?");
		assert.equal(seen.options.signal, signal);
		assert.match(seen.message, /^WARNING: full mode permits Claude Code to write files and run Bash commands/);
		assert.match(seen.message, /Mode: full/);
		assert.match(seen.message, /Model: opus/);
		assert.match(seen.message, /Claude Code model: claude-/);
		assert.match(seen.message, /Working directory: \/work\/project/);
		assert.match(seen.message, /Isolated: no/);
		assert.match(seen.message, /┌─ BEGIN PROMPT PREVIEW\n│ line one\n│ line two\n└─ END PROMPT PREVIEW/);
		assert.equal(calls.length, 1);
		assert.equal(result.details.cancelled, undefined);
	});

	for (const [label, confirm] of [
		["decline", async () => false],
		["timeout", async () => false],
	]) {
		it(`${label} returns cancellation and never starts the query`, async () => {
			const calls = [];
			const result = await execute({}, context(confirm), successRunner(calls));
			assert.equal(calls.length, 0);
			assert.equal(result.details.cancelled, true);
			assert.equal(result.details.error, undefined);
			assert.match(result.content[0].text, /cancelled|not started/i);
		});
	}

	it("fails closed without an interactive UI", async () => {
		let confirms = 0;
		const calls = [];
		const result = await execute(
			{},
			context(async () => { confirms++; return true; }, { hasUI: false }),
			successRunner(calls),
		);
		assert.equal(confirms, 0);
		assert.equal(calls.length, 0);
		assert.equal(result.details.cancelled, true);
		assert.match(result.content[0].text, /confirmation is required.*no interactive UI/i);
	});

	it("an abort dismissing the dialog cancels without starting the query", async () => {
		const controller = new AbortController();
		const calls = [];
		const dialogStarted = deferred();
		const resultPromise = execute(
			{},
			context((_title, _message, options) => new Promise((_resolve, reject) => {
				dialogStarted.resolve();
				options.signal.addEventListener("abort", () => {
					const error = new Error("dismissed");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			})),
			successRunner(calls),
			controller.signal,
		);
		await dialogStarted.promise;
		controller.abort();
		const result = await resultPromise;
		assert.equal(calls.length, 0);
		assert.equal(result.details.cancelled, true);
		assert.match(result.content[0].text, /cancelled before Claude Code started/i);
	});

	it("serializes dialogs but lets the first process run while the second dialog is displayed", async () => {
		const firstDialog = deferred();
		const secondDialog = deferred();
		const firstProcess = deferred();
		const dialogPrompts = [];
		const running = [];
		const ctx = context(async (_title, message) => {
			const prompt = message.includes("│ first") ? "first" : "second";
			dialogPrompts.push(prompt);
			return prompt === "first" ? firstDialog.promise : secondDialog.promise;
		});
		const runner = async (prompt) => {
			running.push(prompt);
			if (prompt === "first") await firstProcess.promise;
			return { responseText: prompt, stopReason: "stop" };
		};

		const first = execute({ prompt: "first" }, ctx, runner);
		const second = execute({ prompt: "second" }, ctx, runner);
		await waitFor(() => dialogPrompts.length === 1, "first dialog was not shown");
		assert.deepEqual(dialogPrompts, ["first"]);
		assert.deepEqual(running, []);

		firstDialog.resolve(true);
		await waitFor(
			() => running.includes("first") && dialogPrompts.includes("second"),
			"second dialog should display while the first process is running",
		);
		assert.deepEqual(running, ["first"]);

		secondDialog.resolve(true);
		await waitFor(() => running.includes("second"), "second process did not start after approval");
		assert.deepEqual(running, ["first", "second"]);
		firstProcess.resolve();
		await Promise.all([first, second]);
	});

	it("releases the dialog queue when confirm rejects", async () => {
		let dialog = 0;
		const running = [];
		const ctx = context(async () => {
			dialog++;
			if (dialog === 1) throw new Error("UI failed");
			return true;
		});
		const runner = successRunner(running);
		const first = execute({ prompt: "reject" }, ctx, runner);
		const second = execute({ prompt: "after reject" }, ctx, runner);
		const [firstResult, secondResult] = await Promise.all([first, second]);

		assert.equal(firstResult.details.cancelled, true);
		assert.match(firstResult.content[0].text, /confirmation could not be completed/i);
		assert.equal(secondResult.details.cancelled, undefined);
		assert.equal(dialog, 2);
		assert.equal(running.length, 1);
	});
});
