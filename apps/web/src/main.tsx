import { render } from "preact";
import { App } from "./app";
import "@xterm/xterm/css/xterm.css";
import "./styles/fonts.css";
import "./styles/variables.css";
import "./styles/global.css";
import "./styles/app.css";

// Apply stored accent color before first paint
const storedAccent = localStorage.getItem("codeck-accent-color");
if (storedAccent && storedAccent !== "#6366f1") {
	const root = document.documentElement;
	root.style.setProperty("--accent", storedAccent);
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(storedAccent);
	if (m) {
		const [r, g, b] = [
			parseInt(m[1], 16),
			parseInt(m[2], 16),
			parseInt(m[3], 16),
		];
		const d = (v: number) => Math.max(0, Math.round(v * 0.88));
		root.style.setProperty(
			"--accent-hover",
			`#${[d(r), d(g), d(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
		);
		root.style.setProperty("--accent-subtle", `rgba(${r}, ${g}, ${b}, 0.10)`);
	}
}

render(<App />, document.getElementById("app")!);

// Register service worker for PWA installability (standalone mode, no browser URL bar)
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}
