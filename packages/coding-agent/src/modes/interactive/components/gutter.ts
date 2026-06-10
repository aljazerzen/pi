import { type ThemeColor, theme } from "../theme/theme.ts";

/**
 * Width (in cells) of the message gutter: a colored bar plus one space.
 * Components should render their content at `width - GUTTER_WIDTH` before
 * applying the gutter so wrapped lines stay within the viewport.
 */
export const GUTTER_WIDTH = 2;

/**
 * No-op background function. Used to strip message/tool backgrounds while
 * keeping the component structure (padding, layout) intact.
 */
export const noBg = (text: string): string => text;

/**
 * Prefix each line with a colored `▐` gutter bar. Blank lines get the bar too,
 * producing a continuous vertical accent down the side of the message.
 */
export function applyGutter(lines: string[], color: ThemeColor): string[] {
	const bar = `${theme.fg(color, "▐")} `;
	return lines.map((line) => bar + line);
}

/** A single guttered blank line, useful as leading/trailing spacing. */
export function gutterBlank(color: ThemeColor): string {
	return `${theme.fg(color, "▐")} `;
}
