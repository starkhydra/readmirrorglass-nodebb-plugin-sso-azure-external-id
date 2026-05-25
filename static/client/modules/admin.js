'use strict';

/*
 * Admin panel client-side script.
 *
 * Uses NodeBB's built-in `settings` module to load/save plugin configuration.
 * The `data-action="save"` button in the template triggers this handler.
 */
define('admin/plugins/sso-azure-external-id', ['settings'], function (Settings) {
	var Module = {};

	Module.init = function () {
		Settings.load('sso-azure-external-id', $('.sso-azure-ext-id-settings'));

		$('[data-action="save"]').on('click', function () {
			Settings.save('sso-azure-external-id', $('.sso-azure-ext-id-settings'), function () {
				app.alert({
					type:     'success',
					alert_id: 'sso-azure-ext-id-saved',
					title:    'Settings saved',
					message:  'Azure Entra External ID SSO settings have been saved. ' +
					          'The OIDC client will be re-initialised on the next login attempt.',
					timeout:  3000,
				});
			});
		});
	};

	return Module;
});
