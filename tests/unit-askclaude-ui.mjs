import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { renderAskClaudeResultView } from "../src/askclaude-ui.js";

initTheme(undefined, false);

const theme = {
	fg(_color, text) {
		return text;
	},
};

const stripAnsi = (text) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

describe("AskClaude result rendering", () => {
	it("uses pi's Markdown component for collapsed and expanded responses", () => {
		const body = "# Finding\n\nUse **one** command:\n\n```ts\nconst answer = 42;\n```";
		const expanded = renderAskClaudeResultView({
			header: "✓ Claude Code",
			body,
			expanded: true,
			prompt: "Review this",
		}, theme);
		const collapsed = renderAskClaudeResultView({
			header: "✓ Claude Code",
			body: "# Finding\n\nUse **one** command:",
			expanded: false,
			truncated: true,
			expandHint: "ctrl+o to expand",
		}, theme);

		assert.ok(expanded.children.some((child) => child instanceof Markdown));
		assert.ok(collapsed.children.some((child) => child instanceof Markdown));

		const expandedText = stripAnsi(expanded.render(80).join("\n"));
		assert.match(expandedText, /Prompt: Review this/);
		assert.match(expandedText, /Finding/);
		assert.match(expandedText, /const answer = 42;/);
		assert.doesNotMatch(expandedText, /\*\*one\*\*/);

		const collapsedText = stripAnsi(collapsed.render(80).join("\n"));
		assert.doesNotMatch(collapsedText, /Prompt:/);
		assert.match(collapsedText, /ctrl\+o to expand/);
	});
});
