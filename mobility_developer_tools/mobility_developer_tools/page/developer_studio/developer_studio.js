// Full screen: Frappe's header is hidden only while this page is shown.
function mdt_set_fullscreen(on) {
	document.body.classList.toggle("mdt-fullscreen", on);
	window.dispatchEvent(new Event("resize")); // let the studio re-measure
}

frappe.pages["developer-studio"].on_page_load = function (wrapper) {
	$(wrapper).on("show", () => mdt_set_fullscreen(true));
	$(wrapper).on("hide", () => mdt_set_fullscreen(false));
	mdt_set_fullscreen(true);
	frappe
		.require(["developer_studio.bundle.js", "developer_studio.bundle.css"])
		.then(() => {
			wrapper.developer_studio = new mobility_developer_tools.DeveloperStudio(wrapper);
		});
}

frappe.pages["developer-studio"].on_page_show = function (wrapper) {
	mdt_set_fullscreen(true);
	wrapper.developer_studio?.on_show();
}
