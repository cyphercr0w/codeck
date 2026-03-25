// Arrow and chevron icons — directional indicators
import type { IconProps } from "./types";

export function IconChevronLeft({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<polyline points="15 18 9 12 15 6" />
		</svg>
	);
}

export function IconChevronRight({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}

export function IconChevronUp({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<polyline points="18 15 12 9 6 15" />
		</svg>
	);
}

export function IconChevronDown({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

export function IconArrowUp({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<line x1="12" y1="19" x2="12" y2="5" />
			<polyline points="5 12 12 5 19 12" />
		</svg>
	);
}
