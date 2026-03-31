// Centralized SVG icon library — replaces all emojis across the app
// All icons are 24x24 viewBox, stroke-based, 1.5px stroke by default

interface IconProps {
	size?: number;
	class?: string;
	style?: string | Record<string, string>;
}

export function IconHome({ size = 18, ...props }: IconProps) {
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
			<path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" />
			<path d="M9 21V12h6v9" />
		</svg>
	);
}

export function IconFolder({ size = 18, ...props }: IconProps) {
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
			<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
		</svg>
	);
}

export function IconFolderOpen({ size = 18, ...props }: IconProps) {
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
			<path d="M5 19a2 2 0 01-2-2V5a2 2 0 012-2h4l2 3h9a2 2 0 012 2v1" />
			<path d="M5 12h16l-2 7H7l-2-7z" />
		</svg>
	);
}

export function IconTerminal({ size = 18, ...props }: IconProps) {
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
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</svg>
	);
}

export function IconPlug({ size = 18, ...props }: IconProps) {
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
			<path d="M12 22v-5" />
			<path d="M9 8V2" />
			<path d="M15 8V2" />
			<path d="M6 8h12v4a6 6 0 01-6 6 6 6 0 01-6-6V8z" />
		</svg>
	);
}

export function IconSettings({ size = 18, ...props }: IconProps) {
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
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
		</svg>
	);
}

export function IconLogout({ size = 18, ...props }: IconProps) {
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
			<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
			<polyline points="16 17 21 12 16 7" />
			<line x1="21" y1="12" x2="9" y2="12" />
		</svg>
	);
}

export function IconFile({ size = 18, ...props }: IconProps) {
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
			<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	);
}

export function IconFileCode({ size = 18, ...props }: IconProps) {
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
			<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
			<polyline points="14 2 14 8 20 8" />
			<polyline points="9 15 12 18 15 15" />
			<polyline points="9 12 12 9 15 12" />
		</svg>
	);
}

export function IconFileText({ size = 18, ...props }: IconProps) {
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
			<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
			<polyline points="14 2 14 8 20 8" />
			<line x1="16" y1="13" x2="8" y2="13" />
			<line x1="16" y1="17" x2="8" y2="17" />
		</svg>
	);
}

export function IconImage({ size = 18, ...props }: IconProps) {
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
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<polyline points="21 15 16 10 5 21" />
		</svg>
	);
}

export function IconArchive({ size = 18, ...props }: IconProps) {
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
			<polyline points="21 8 21 21 3 21 3 8" />
			<rect x="1" y="3" width="22" height="5" />
			<line x1="10" y1="12" x2="14" y2="12" />
		</svg>
	);
}

export function IconKey({ size = 18, ...props }: IconProps) {
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
			<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
		</svg>
	);
}

export function IconGithub({ size = 18, ...props }: IconProps) {
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
			<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22" />
		</svg>
	);
}

export function IconPackage({ size = 18, ...props }: IconProps) {
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
			<line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
			<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
			<polyline points="3.27 6.96 12 12.01 20.73 6.96" />
			<line x1="12" y1="22.08" x2="12" y2="12" />
		</svg>
	);
}

// ── Brand Icons (filled, for integrations) ──

export function IconSupabase({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 109 113"
			fill="none"
			{...props}
		>
			<path
				d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627H99.1935C108.384 40.0627 113.394 51.01 107.461 57.7508L63.7076 110.284Z"
				fill="url(#sb-a)"
			/>
			<path
				d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627H99.1935C108.384 40.0627 113.394 51.01 107.461 57.7508L63.7076 110.284Z"
				fill="url(#sb-b)"
				fill-opacity="0.2"
			/>
			<path
				d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C0.640828 72.2922 -4.36938 61.3449 1.56336 54.6042L45.317 2.07103Z"
				fill="#3ECF8E"
			/>
			<defs>
				<linearGradient
					id="sb-a"
					x1="53.9738"
					y1="54.974"
					x2="94.1635"
					y2="71.8295"
					gradientUnits="userSpaceOnUse"
				>
					<stop stop-color="#249361" />
					<stop offset="1" stop-color="#3ECF8E" />
				</linearGradient>
				<linearGradient
					id="sb-b"
					x1="36.1558"
					y1="30.578"
					x2="54.4844"
					y2="65.0806"
					gradientUnits="userSpaceOnUse"
				>
					<stop />
					<stop offset="1" stop-opacity="0" />
				</linearGradient>
			</defs>
		</svg>
	);
}

export function IconVercel({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			{...props}
		>
			<path d="M12 1L24 22H0L12 1Z" />
		</svg>
	);
}

export function IconStripe({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<rect width="24" height="24" rx="4" fill="#635BFF" />
			<path
				d="M11.1 9.67c0-.66.54-1.01 1.44-1.01.97 0 2.19.29 3.16.82V6.59a8.47 8.47 0 00-3.16-.59c-2.59 0-4.31 1.35-4.31 3.61 0 3.52 4.85 2.96 4.85 4.48 0 .78-.68 1.03-1.63 1.03-1.41 0-2.73-.58-3.63-1.23v2.93A9.2 9.2 0 0011.45 18c2.65 0 4.47-1.31 4.47-3.6-.01-3.8-4.81-3.13-4.81-4.73z"
				fill="white"
			/>
		</svg>
	);
}

export function IconNotion({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			{...props}
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L18.4 2.293c-.42-.326-.98-.7-2.055-.607L3.39 2.78c-.467.047-.56.28-.374.466l1.443.962zm.793 2.89v13.872c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.934-.56.934-1.166V6.052c0-.607-.234-.933-.747-.887l-15.177.887c-.56.047-.747.327-.747.886zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.747 0-.934-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.187c-.093-.187 0-.653.327-.747l.84-.234V8.82L7.92 8.68c-.094-.42.14-1.026.793-1.073l3.456-.234 4.764 7.28V8.306l-1.214-.14c-.094-.514.28-.887.747-.933l3.222-.187h-.093z" />
		</svg>
	);
}

export function IconGoogle({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path
				d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
				fill="#4285F4"
			/>
			<path
				d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
				fill="#34A853"
			/>
			<path
				d="M5.84 14.09A6.97 6.97 0 015.47 12c0-.72.13-1.43.37-2.09V7.07H2.18A11.96 11.96 0 001 12c0 1.94.46 3.77 1.18 5.27l3.66-3.18z"
				fill="#FBBC05"
			/>
			<path
				d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
				fill="#EA4335"
			/>
		</svg>
	);
}

export function IconCloudflare({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path
				d="M16.51 15.86l.46-1.56c.13-.44.08-.85-.14-1.15-.2-.28-.53-.44-.93-.47l-8.59-.11c-.06 0-.11-.03-.14-.08a.17.17 0 01-.02-.16.19.19 0 01.17-.13l8.68-.11c.93-.05 1.94-.8 2.36-1.77l.53-1.23a.3.3 0 00.02-.2 5.77 5.77 0 00-11.1-1.1 3.33 3.33 0 00-5.22 2.35A4.47 4.47 0 001 15.36a.38.38 0 00.37.5h14.78c.16 0 .3-.11.36-.27v.27z"
				fill="#F6821F"
			/>
			<path
				d="M19.35 9.88l-.24.01a.16.16 0 00-.14.11l-.36 1.24c-.13.44-.08.85.14 1.15.2.28.53.44.93.47l1.85.11c.06 0 .11.04.14.08.03.05.03.11.02.16a.19.19 0 01-.17.13l-1.93.11c-.94.05-1.95.8-2.37 1.77l-.15.34a.09.09 0 00.08.13h5.88a.37.37 0 00.36-.28 4.64 4.64 0 00-4.04-5.42z"
				fill="#FBAD41"
			/>
		</svg>
	);
}

export function IconFigma({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path d="M8.5 2h3v6.5h-3a3.25 3.25 0 010-6.5z" fill="#F24E1E" />
			<path d="M11.5 2h3a3.25 3.25 0 010 6.5h-3V2z" fill="#FF7262" />
			<path d="M11.5 8.5H14.75a3.25 3.25 0 110 6.5H11.5V8.5z" fill="#A259FF" />
			<path d="M8.5 8.5h3V15h-3a3.25 3.25 0 010-6.5z" fill="#1ABCFE" />
			<path d="M8.5 15h3v3.25a3.25 3.25 0 01-3-3.25z" fill="#0ACF83" />
		</svg>
	);
}

export function IconLock({ size = 18, ...props }: IconProps) {
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
			<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
			<path d="M7 11V7a5 5 0 0110 0v4" />
		</svg>
	);
}

export function IconBridge({ size = 18, ...props }: IconProps) {
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
			<path d="M2 18h20" />
			<path d="M6 18V8" />
			<path d="M18 18V8" />
			<path d="M6 8c0-3 2.5-5 6-5s6 2 6 5" />
			<path d="M10 18v-4" />
			<path d="M14 18v-4" />
			<path d="M2 14h20" />
		</svg>
	);
}

export function IconPlus({ size = 18, ...props }: IconProps) {
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
			<line x1="12" y1="5" x2="12" y2="19" />
			<line x1="5" y1="12" x2="19" y2="12" />
		</svg>
	);
}

export function IconX({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<line x1="18" y1="6" x2="6" y2="18" />
			<line x1="6" y1="6" x2="18" y2="18" />
		</svg>
	);
}

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

export function IconRefresh({ size = 18, ...props }: IconProps) {
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
			<polyline points="23 4 23 10 17 10" />
			<path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
		</svg>
	);
}

export function IconEdit({ size = 18, ...props }: IconProps) {
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
			<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
			<path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
		</svg>
	);
}

export function IconSave({ size = 18, ...props }: IconProps) {
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
			<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
			<polyline points="17 21 17 13 7 13 7 21" />
			<polyline points="7 3 7 8 15 8" />
		</svg>
	);
}

export function IconCopy({ size = 18, ...props }: IconProps) {
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
			<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
			<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
		</svg>
	);
}

export function IconDownload({ size = 18, ...props }: IconProps) {
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
			<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

export function IconCheck({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}

export function IconShell({ size = 18, ...props }: IconProps) {
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
			<rect x="2" y="4" width="20" height="16" rx="2" />
			<path d="M6 9l3 3-3 3" />
			<path d="M12 17h5" />
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

export function IconUser({ size = 18, ...props }: IconProps) {
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
			<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
			<circle cx="12" cy="7" r="4" />
		</svg>
	);
}

export function IconMonitor({ size = 18, ...props }: IconProps) {
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
			<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
			<line x1="8" y1="21" x2="16" y2="21" />
			<line x1="12" y1="17" x2="12" y2="21" />
		</svg>
	);
}

export function IconActivity({ size = 18, ...props }: IconProps) {
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
			<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
		</svg>
	);
}

export function IconShield({ size = 18, ...props }: IconProps) {
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
			<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
		</svg>
	);
}

export function IconBrain({ size = 18, ...props }: IconProps) {
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
			<path d="M12 2a7 7 0 00-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 002 2h4a2 2 0 002-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 00-7-7z" />
			<path d="M9 21h6" />
			<path d="M10 17v4" />
			<path d="M14 17v4" />
			<path d="M12 2v5" />
			<path d="M8 6l2 3" />
			<path d="M16 6l-2 3" />
		</svg>
	);
}

export function IconCalendar({ size = 18, ...props }: IconProps) {
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
			<rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
			<line x1="16" y1="2" x2="16" y2="6" />
			<line x1="8" y1="2" x2="8" y2="6" />
			<line x1="3" y1="10" x2="21" y2="10" />
		</svg>
	);
}

export function IconBookmark({ size = 18, ...props }: IconProps) {
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
			<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z" />
		</svg>
	);
}

export function IconSearch({ size = 18, ...props }: IconProps) {
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
			<circle cx="11" cy="11" r="8" />
			<line x1="21" y1="21" x2="16.65" y2="16.65" />
		</svg>
	);
}

export function IconHardDrive({ size = 18, ...props }: IconProps) {
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
			<line x1="22" y1="12" x2="2" y2="12" />
			<path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
			<line x1="6" y1="16" x2="6.01" y2="16" />
			<line x1="10" y1="16" x2="10.01" y2="16" />
		</svg>
	);
}

export function IconBot({ size = 18, ...props }: IconProps) {
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
			<rect x="3" y="11" width="18" height="10" rx="2" />
			<circle cx="9" cy="16" r="1" />
			<circle cx="15" cy="16" r="1" />
			<path d="M12 2v4" />
			<path d="M8 7h8" />
			<path d="M12 7v4" />
			<path d="M1 15h2" />
			<path d="M21 15h2" />
		</svg>
	);
}

export function IconList({ size = 18, ...props }: IconProps) {
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
			<line x1="8" y1="6" x2="21" y2="6" />
			<line x1="8" y1="12" x2="21" y2="12" />
			<line x1="8" y1="18" x2="21" y2="18" />
			<line x1="3" y1="6" x2="3.01" y2="6" />
			<line x1="3" y1="12" x2="3.01" y2="12" />
			<line x1="3" y1="18" x2="3.01" y2="18" />
		</svg>
	);
}

export function IconPlay({ size = 18, ...props }: IconProps) {
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
			<polygon points="5 3 19 12 5 21 5 3" />
		</svg>
	);
}

export function IconPause({ size = 18, ...props }: IconProps) {
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
			<rect x="6" y="4" width="4" height="16" />
			<rect x="14" y="4" width="4" height="16" />
		</svg>
	);
}

export function IconTrash({ size = 18, ...props }: IconProps) {
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
			<polyline points="3 6 5 6 21 6" />
			<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
		</svg>
	);
}

export function IconChat({ size = 18, ...props }: IconProps) {
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
			<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z" />
		</svg>
	);
}

export function IconFlow({ size = 18, ...props }: IconProps) {
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
			<circle cx="5" cy="6" r="3" />
			<circle cx="19" cy="6" r="3" />
			<circle cx="12" cy="18" r="3" />
			<path d="M6.5 8.5L10.5 16" />
			<path d="M17.5 8.5L13.5 16" />
		</svg>
	);
}

export function IconExternalLink({ size = 18, ...props }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			{...props}
		>
			<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
			<polyline points="15 3 21 3 21 9" />
			<line x1="10" y1="14" x2="21" y2="3" />
		</svg>
	);
}

export function IconSlack({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path d="M8.5 15a1.5 1.5 0 11-1.5-1.5H8.5V15z" fill="#E01E5A" />
			<path
				d="M9.5 15a1.5 1.5 0 013 0v3.5a1.5 1.5 0 01-3 0V15z"
				fill="#E01E5A"
			/>
			<path d="M9 8.5A1.5 1.5 0 1110.5 7V8.5H9z" fill="#36C5F0" />
			<path d="M9 9.5a1.5 1.5 0 010 3H5.5a1.5 1.5 0 010-3H9z" fill="#36C5F0" />
			<path d="M15.5 9a1.5 1.5 0 111.5 1.5H15.5V9z" fill="#2EB67D" />
			<path
				d="M14.5 9a1.5 1.5 0 01-3 0V5.5a1.5 1.5 0 013 0V9z"
				fill="#2EB67D"
			/>
			<path d="M15 15.5a1.5 1.5 0 11-1.5 1.5V15.5H15z" fill="#ECB22E" />
			<path
				d="M15 14.5a1.5 1.5 0 010-3h3.5a1.5 1.5 0 010 3H15z"
				fill="#ECB22E"
			/>
		</svg>
	);
}

export function IconLinear({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path
				d="M3.5 14.5L9.5 20.5C6.2 19.8 4.2 17.8 3.5 14.5z"
				fill="currentColor"
			/>
			<path
				d="M3 12.4L11.6 21C10.8 21 10 20.9 9.3 20.6L3.4 14.7C3.1 14 3 13.2 3 12.4z"
				fill="currentColor"
			/>
			<path
				d="M3.2 10.2L13.8 20.8C13.1 20.9 12.4 21 11.6 21L3 12.4C3 11.6 3.1 10.9 3.2 10.2z"
				fill="currentColor"
			/>
			<path
				d="M4.1 8.2L15.8 19.9C15.2 20.2 14.5 20.5 13.8 20.7L3.3 10.2C3.5 9.5 3.8 8.8 4.1 8.2z"
				fill="currentColor"
			/>
			<path
				d="M5.7 6.4L17.6 18.3C17 18.7 16.4 19.1 15.8 19.4L4.6 8.2C5 7.6 5.3 7 5.7 6.4z"
				fill="currentColor"
			/>
			<path
				d="M20.5 14.5C19.8 17.8 17.8 19.8 14.5 20.5L3.5 9.5C4.2 6.2 6.2 4.2 9.5 3.5L20.5 14.5z"
				fill="currentColor"
			/>
			<path
				d="M21 11.6C21 12.4 20.9 13.2 20.6 13.9L10.1 3.4C10.8 3.1 11.6 3 12.4 3L21 11.6z"
				fill="currentColor"
			/>
		</svg>
	);
}

export function IconAWS({ size = 18, ...props }: IconProps) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
			<path
				d="M6.76 10.37c0 .28.03.51.08.67.06.16.14.34.25.53.04.07.06.14.06.2 0 .1-.05.19-.16.28l-.53.35a.4.4 0 01-.22.08c-.08 0-.17-.04-.25-.11a2.6 2.6 0 01-.3-.39 6.6 6.6 0 01-.26-.49c-.65.77-1.47 1.15-2.45 1.15-.7 0-1.26-.2-1.67-.6-.41-.4-.62-.93-.62-1.6 0-.7.25-1.27.76-1.7.5-.42 1.17-.64 2.02-.64.28 0 .57.02.88.07.3.04.62.11.95.2V7.9c0-.65-.14-1.1-.4-1.37-.28-.27-.75-.4-1.43-.4-.31 0-.62.04-.95.12a7 7 0 00-.95.31c-.14.06-.24.1-.3.11a.53.53 0 01-.13.02c-.12 0-.18-.09-.18-.27v-.42c0-.14.02-.24.07-.3a.72.72 0 01.28-.18c.31-.16.68-.29 1.1-.4.44-.1.9-.16 1.4-.16.99 0 1.73.23 2.2.68.47.45.7 1.13.7 2.04v2.7zm-3.38 1.26c.27 0 .55-.05.85-.15.3-.1.56-.28.78-.53.13-.16.23-.34.28-.54.05-.2.08-.45.08-.74v-.36a6.9 6.9 0 00-.76-.14 6.2 6.2 0 00-.78-.05c-.55 0-.96.11-1.23.33-.27.22-.4.53-.4.94 0 .38.1.67.3.86.19.19.47.28.88.28zm6.65.9c-.15 0-.26-.03-.33-.08-.07-.04-.13-.15-.18-.3l-2.03-6.68c-.05-.16-.08-.26-.08-.32 0-.13.06-.2.19-.2h.77c.16 0 .27.03.33.08.07.04.12.15.17.3l1.45 5.72 1.35-5.72c.04-.16.1-.26.17-.3.08-.05.2-.08.35-.08h.63c.16 0 .27.03.35.08.07.04.13.15.17.3l1.36 5.79 1.5-5.79c.05-.16.1-.26.17-.3.07-.05.18-.08.33-.08h.73c.13 0 .2.06.2.2 0 .04-.01.08-.02.13a1.3 1.3 0 01-.06.2l-2.09 6.67c-.05.16-.1.26-.18.3-.07.05-.18.08-.32.08h-.68c-.16 0-.27-.03-.35-.08-.07-.05-.13-.16-.17-.3l-1.35-5.6-1.34 5.59c-.05.15-.1.25-.17.3-.08.05-.2.08-.36.08h-.67zm11.1.22c-.41 0-.82-.05-1.22-.14-.4-.1-.71-.2-.92-.33a.58.58 0 01-.23-.21.51.51 0 01-.07-.26v-.44c0-.18.07-.27.2-.27.05 0 .1.01.15.03.05.02.13.05.21.09.29.13.6.23.93.3.34.07.67.1 1.01.1.53 0 .95-.09 1.24-.28.29-.18.44-.45.44-.79 0-.23-.07-.42-.22-.58-.15-.16-.43-.3-.83-.43l-1.2-.37c-.6-.19-1.05-.47-1.32-.84a2 2 0 01-.41-1.22c0-.35.08-.66.23-.93.16-.27.37-.5.63-.69.27-.19.57-.33.91-.43.35-.1.71-.14 1.1-.14.19 0 .39.01.58.04.2.03.38.06.55.1.17.05.33.1.48.15.15.06.27.11.35.17a.73.73 0 01.25.2.47.47 0 01.07.27v.41c0 .18-.07.28-.2.28a.9.9 0 01-.33-.11 3.98 3.98 0 00-1.65-.34c-.49 0-.87.08-1.13.24-.27.16-.4.4-.4.73 0 .24.08.44.25.6.16.16.46.32.9.46l1.17.37c.6.19 1.03.45 1.28.8.25.34.38.73.38 1.16 0 .36-.07.68-.22.97-.15.28-.36.53-.62.73-.27.2-.58.35-.96.46-.38.1-.79.16-1.23.16z"
				fill="#FF9900"
			/>
			<path
				d="M20.16 17.74c-2.47 1.82-6.05 2.79-9.13 2.79-4.32 0-8.2-1.6-11.14-4.25-.23-.21-.02-.49.25-.33 3.17 1.84 7.09 2.95 11.13 2.95 2.73 0 5.73-.57 8.49-1.74.42-.18.77.27.4.58z"
				fill="#FF9900"
			/>
			<path
				d="M21.17 16.59c-.31-.4-2.07-.19-2.86-.1-.24.03-.28-.18-.06-.33 1.4-.98 3.69-.7 3.96-.37.27.34-.07 2.62-1.38 3.71-.2.17-.39.08-.3-.14.29-.74.95-2.37.64-2.77z"
				fill="#FF9900"
			/>
		</svg>
	);
}

// File icon resolver - returns appropriate icon component for file extensions
export function getFileIcon(name: string, size = 16): preact.JSX.Element {
	const ext = name.split(".").pop()?.toLowerCase() || "";
	const codeExts = [
		"js",
		"ts",
		"jsx",
		"tsx",
		"py",
		"rb",
		"go",
		"rs",
		"java",
		"c",
		"cpp",
		"h",
		"css",
		"scss",
		"html",
		"vue",
		"svelte",
	];
	const textExts = [
		"md",
		"txt",
		"log",
		"csv",
		"yml",
		"yaml",
		"toml",
		"ini",
		"cfg",
		"env",
	];
	const imageExts = ["jpg", "jpeg", "png", "gif", "svg", "webp", "ico", "bmp"];
	const archiveExts = ["zip", "tar", "gz", "bz2", "rar", "7z", "tgz"];

	if (codeExts.includes(ext)) return <IconFileCode size={size} />;
	if (textExts.includes(ext)) return <IconFileText size={size} />;
	if (imageExts.includes(ext)) return <IconImage size={size} />;
	if (archiveExts.includes(ext)) return <IconArchive size={size} />;
	if (ext === "json") return <IconFileCode size={size} />;
	return <IconFile size={size} />;
}
