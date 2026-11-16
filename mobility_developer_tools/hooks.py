app_name = "mobility_developer_tools"
app_title = "Mobility Developer Tools"
app_publisher = "Mobility Pro"
app_description = "VS Code-like developer studio for Frappe: file explorer, editor, script runner and interactive terminal"
app_email = "admin@mobilityp.com"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "mobility_developer_tools",
# 		"logo": "/assets/mobility_developer_tools/logo.png",
# 		"title": "Mobility Developer Tools",
# 		"route": "/mobility_developer_tools",
# 		"has_permission": "mobility_developer_tools.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/mobility_developer_tools/css/mobility_developer_tools.css"
# app_include_js = "/assets/mobility_developer_tools/js/mobility_developer_tools.js"

# include js, css files in header of web template
# web_include_css = "/assets/mobility_developer_tools/css/mobility_developer_tools.css"
# web_include_js = "/assets/mobility_developer_tools/js/mobility_developer_tools.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "mobility_developer_tools/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "mobility_developer_tools/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "mobility_developer_tools.utils.jinja_methods",
# 	"filters": "mobility_developer_tools.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "mobility_developer_tools.install.before_install"
# after_install = "mobility_developer_tools.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "mobility_developer_tools.uninstall.before_uninstall"
# after_uninstall = "mobility_developer_tools.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "mobility_developer_tools.utils.before_app_install"
# after_app_install = "mobility_developer_tools.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "mobility_developer_tools.utils.before_app_uninstall"
# after_app_uninstall = "mobility_developer_tools.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "mobility_developer_tools.build.after_build"

# To hook into the build process of other apps
# The list of apps being built is passed as an argument

# after_app_build = "mobility_developer_tools.build.after_app_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "mobility_developer_tools.notifications.get_notification_config"

# Awesome Bar
# -----------
# Extra search results: list of dicts with label, description, route, index.
# route: ["List", "ToDo"], "/desk/docs/some/page", or "https://example.com"
# awesomebar_search = ["mobility_developer_tools.search.awesomebar_results"]

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# DocType Class
# ---------------
# Override standard doctype classes

# override_doctype_class = {
# 	"ToDo": "custom_app.overrides.CustomToDo"
# }

# Document Events
# ---------------
# Hook on document methods and events

# doc_events = {
# 	"*": {
# 		"on_update": "method",
# 		"on_cancel": "method",
# 		"on_trash": "method"
# 	}
# }

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"mobility_developer_tools.tasks.all"
# 	],
# 	"daily": [
# 		"mobility_developer_tools.tasks.daily"
# 	],
# 	"hourly": [
# 		"mobility_developer_tools.tasks.hourly"
# 	],
# 	"weekly": [
# 		"mobility_developer_tools.tasks.weekly"
# 	],
# 	"monthly": [
# 		"mobility_developer_tools.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "mobility_developer_tools.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "mobility_developer_tools.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "mobility_developer_tools.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["mobility_developer_tools.utils.before_request"]
# after_request = ["mobility_developer_tools.utils.after_request"]

# Job Events
# ----------
# before_job = ["mobility_developer_tools.utils.before_job"]
# after_job = ["mobility_developer_tools.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"mobility_developer_tools.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []


# Apps screen
# ------------------
add_to_apps_screen = [
	{
		"name": "mobility_developer_tools",
		"logo": "/assets/mobility_developer_tools/images/logo.svg",
		"title": "Developer Tools",
		# Not "/app/developer-studio": the apps screen treats every "/app/<x>" route as a
		# workspace and falls back to the first workspace (Home) when <x> is not one.
		"route": "/developer-studio",
		"has_permission": "mobility_developer_tools.studio.api.has_app_permission",
	}
]

website_redirects = [
	{"source": "/developer-studio", "target": "/app/developer-studio"},
]

# Developer Studio
# ------------------
# Other apps can add script runners (subclasses of
# mobility_developer_tools.studio.runners.base.ScriptRunner):
# developer_studio_runners = ["my_app.studio.MyRunner"]
