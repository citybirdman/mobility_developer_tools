frappe.pages["developer-studio"].on_page_load = function (wrapper) {
	frappe
		.require(["developer_studio.bundle.js", "developer_studio.bundle.css"])
		.then(() => {
			wrapper.developer_studio = new mobility_developer_tools.DeveloperStudio(wrapper);
		});
};

frappe.pages["developer-studio"].on_page_show = function (wrapper) {
	wrapper.developer_studio?.on_show();
};
