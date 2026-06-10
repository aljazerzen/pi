import { Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { applyGutter, GUTTER_WIDTH } from "./gutter.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message.
 *
 * Styling: no background. The message is marked with a colored `▌` gutter bar
 * down its left edge.
 */
export class UserMessageComponent extends Container {
	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		// Content sits directly after the gutter bar; the gutter provides the
		// horizontal offset, so no additional Markdown padding is applied.
		this.addChild(
			new Markdown(
				text,
				0,
				0,
				markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, markdownTransformers),
				},
			),
		);
	}

	override render(width: number): string[] {
		const inner = super.render(Math.max(1, width - GUTTER_WIDTH));
		const lines = applyGutter(inner, "accent");
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
