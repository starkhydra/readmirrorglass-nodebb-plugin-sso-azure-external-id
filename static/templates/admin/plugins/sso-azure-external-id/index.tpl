<div class="row">
	<div class="col-lg-9">

		<div class="panel panel-default">
			<div class="panel-heading">Azure Entra External ID — SSO Settings</div>
			<div class="panel-body">

				<p class="text-muted">
					Allows users to sign in with a Microsoft / Azure Entra External ID account.<br/>
					Configure an <strong>Authorization Code + PKCE</strong> app registration in your
					<a href="https://portal.azure.com" target="_blank" rel="noopener">Azure portal</a>
					and fill in the values below.
				</p>
				<hr/>

				<form role="form" class="sso-azure-ext-id-settings">

					<!-- Authority URL -->
					<div class="form-group">
						<label for="authority">Authority URL <span class="text-danger">*</span></label>
						<input type="url" id="authority" name="authority"
							class="form-control" value="{settings.authority}"
							placeholder="https://&lt;tenant&gt;.ciamlogin.com/" />
						<p class="help-block">
							The Entra External ID (CIAM) authority — just the base URL, <strong>without</strong>
							a tenant path or <code>/v2.0</code> suffix. The plugin handles endpoint discovery
							internally.<br/>
							Example: <code>https://contoso.ciamlogin.com/</code>
						</p>
					</div>

					<!-- Client ID -->
					<div class="form-group">
						<label for="clientId">Application (Client) ID <span class="text-danger">*</span></label>
						<input type="text" id="clientId" name="clientId"
							class="form-control" value="{settings.clientId}"
							placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
						<p class="help-block">
							The app registration's client ID from the Azure portal.
						</p>
					</div>

					<!-- Client Secret -->
					<div class="form-group">
						<label for="clientSecret">Client Secret <span class="text-danger">*</span></label>
						<input type="password" id="clientSecret" name="clientSecret"
							class="form-control" value="{settings.clientSecret}"
							placeholder="(stored securely)" />
						<p class="help-block">
							A client secret from <em>Certificates &amp; secrets</em> in the Azure portal.
							The secret is stored in NodeBB's database and never transmitted to the browser.
						</p>
					</div>

					<!-- Callback URL -->
					<div class="form-group">
						<label for="callbackUrl">Redirect URI</label>
						<input type="url" id="callbackUrl" name="callbackUrl"
							class="form-control" value="{settings.callbackUrl}"
							placeholder="{config.url}/auth/azure-ext-id/callback" />
						<p class="help-block">
							Leave blank to use the default: <code>{config.url}/auth/azure-ext-id/callback</code><br/>
							This URI must be listed in your Azure app registration's <em>Redirect URIs</em>.
						</p>
					</div>

					<!-- Button label -->
					<div class="form-group">
						<label for="buttonLabel">Login Button Label</label>
						<input type="text" id="buttonLabel" name="buttonLabel"
							class="form-control" value="{settings.buttonLabel}"
							placeholder="Microsoft" />
						<p class="help-block">Text shown on the login button. Defaults to "Microsoft".</p>
					</div>

					<!-- Auto-link -->
					<div class="form-group">
						<div class="checkbox">
							<label>
								<input type="checkbox" id="autoLink" name="autoLink"
									<!-- IF settings.autoLink -->checked<!-- ENDIF settings.autoLink --> />
								Auto-link existing accounts by email
							</label>
						</div>
						<p class="help-block">
							When enabled, a first-time CIAM login will be linked to an existing NodeBB account
							that shares the same email address rather than creating a duplicate account.
							Disable this if your forum has untrusted email addresses from other SSO providers.
						</p>
					</div>

					<hr/>
					<h4>Claim Mappings</h4>
					<p class="text-muted">
						Each field is a comma-separated list of ID token claim names tried in order — the
						first non-empty value wins. Change these only if your Entra tenant delivers
						attributes under non-standard names. Dot notation is supported for nested claims
						(e.g. <code>signInNames.emailAddress</code>).
					</p>

					<!-- OID claim -->
					<div class="form-group">
						<label for="claimOid">User identifier (OID) claim</label>
						<input type="text" id="claimOid" name="claimOid"
							class="form-control" value="{settings.claimOid}"
							placeholder="oid" />
						<p class="help-block">
							The claim used as the stable unique key for each user.
							<strong>Default: <code>oid</code></strong> — Entra's object ID, guaranteed never
							to rotate. Only change this if you have a custom policy that remaps the identifier.
						</p>
					</div>

					<!-- Email claim -->
					<div class="form-group">
						<label for="claimEmail">Email claim</label>
						<input type="text" id="claimEmail" name="claimEmail"
							class="form-control" value="{settings.claimEmail}"
							placeholder="email,preferred_username,emails,signInNames.emailAddress" />
						<p class="help-block">
							<strong>Default: <code>email, preferred_username, emails, signInNames.emailAddress</code></strong><br/>
							Entra CIAM tenants are inconsistent about which claim holds the email address.
							The default list covers every known shape. If your tenant uses a custom attribute,
							add it here (e.g. <code>extension_email</code>).
						</p>
					</div>

					<!-- Display name claim -->
					<div class="form-group">
						<label for="claimName">Display name claim</label>
						<input type="text" id="claimName" name="claimName"
							class="form-control" value="{settings.claimName}"
							placeholder="name,displayName" />
						<p class="help-block">
							<strong>Default: <code>name, displayName</code></strong><br/>
							If none of these are present, the plugin automatically concatenates
							<code>given_name</code> + <code>family_name</code> as a fallback.
						</p>
					</div>

					<!-- Username claim (optional) -->
					<div class="form-group">
						<label for="claimUsername">Username claim <span class="text-muted">(optional)</span></label>
						<input type="text" id="claimUsername" name="claimUsername"
							class="form-control" value="{settings.claimUsername}"
							placeholder="(leave blank to derive from display name / email)" />
						<p class="help-block">
							If your tenant emits a dedicated username claim (e.g. <code>nickname</code>,
							<code>preferred_username</code>, or a custom attribute), set it here and new
							accounts will use that value as their NodeBB username. Leave blank to derive
							the username from the display name or email prefix.
						</p>
					</div>

				</form>

				<hr/>

				<div class="panel panel-info">
					<div class="panel-heading"><i class="fa fa-info-circle"></i> Azure portal checklist</div>
					<div class="panel-body">
						<ol>
							<li>In your Entra External ID tenant, create an app registration (or reuse an existing one).</li>
							<li>Under <strong>Authentication → Platform configurations</strong>, add a
								<em>Web</em> platform with the <strong>Redirect URI</strong> set to the value above.</li>
							<li>Under <strong>Certificates &amp; secrets</strong>, create a new client secret.</li>
							<li>Under <strong>Token configuration</strong>, add optional claims:
								<code>email</code>, <code>name</code>, and <code>preferred_username</code>
								to the <em>ID token</em>.</li>
							<li>Make sure <strong>oid</strong> is included — it is present in all ID tokens by default
								and is used as the stable user key.</li>
						</ol>
					</div>
				</div>

			</div>
		</div>

	</div>

	<div class="col-lg-3">
		<button class="btn btn-primary" data-action="save" type="button">
			<i class="fa fa-save"></i> Save Settings
		</button>
	</div>
</div>
