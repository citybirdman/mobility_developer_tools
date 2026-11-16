export const LIB_BASE = "/assets/mobility_developer_tools/lib";

let loading = null;

/**
 * Loads xterm.js and Monaco (vendored in public/lib).
 *
 * xterm is loaded first so its UMD build registers globals. Monaco brings an AMD
 * loader; afterwards `define.amd` is removed so UMD libraries Frappe loads later
 * still register as globals instead of anonymous AMD modules.
 */
export function loadStudioAssets() {
	if (!loading) {
		loading = (async () => {
			loadCss(`${LIB_BASE}/xterm/xterm.css`);
			if (!window.Terminal) await loadScript(`${LIB_BASE}/xterm/xterm.js`);
			if (!window.FitAddon) await loadScript(`${LIB_BASE}/xterm/addon-fit.js`);
			await loadMonaco();
		})();
		loading.catch(() => (loading = null));
	}
	return loading;
}

async function loadMonaco() {
	if (window.monaco?.editor) return;

	const base = `${LIB_BASE}/monaco`;
	await loadScript(`${base}/vs/loader.js`);
	const amdRequire = window.require;

	window.MonacoEnvironment = {
		getWorkerUrl() {
			const origin = window.location.origin;
			const src =
				`self.MonacoEnvironment = { baseUrl: '${origin}${base}/' };` +
				`importScripts('${origin}${base}/vs/base/worker/workerMain.js');`;
			return `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`;
		},
	};

	amdRequire.config({ paths: { vs: `${base}/vs` } });
	await new Promise((resolve, reject) => amdRequire(["vs/editor/editor.main"], resolve, reject));

	window.mdtAmdRequire = amdRequire;
	if (window.define?.amd) delete window.define.amd;
}

function loadScript(src) {
	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = src;
		script.onload = resolve;
		script.onerror = () => reject(new Error(`Failed to load ${src}`));
		document.head.appendChild(script);
	});
}

function loadCss(href) {
	if (document.querySelector(`link[href="${href}"]`)) return;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = href;
	document.head.appendChild(link);
}
