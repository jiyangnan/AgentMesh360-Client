use agent_client_protocol as acp;
use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::credential_vault::{CredentialRef, CredentialVault, SecretValue, SystemCredentialVault};
use super::provider_profiles::{ProviderProfileInput, ProviderProfileRecord, ProviderProfileStore};

pub const PROVIDERS_LIST_METHOD: &str = "x.agentmesh360/providers/list";
pub const PROVIDERS_CREATE_METHOD: &str = "x.agentmesh360/providers/create";
pub const PROVIDERS_UPDATE_METHOD: &str = "x.agentmesh360/providers/update";
pub const PROVIDERS_REPLACE_SECRET_METHOD: &str = "x.agentmesh360/providers/replace-secret";
pub const PROVIDERS_DELETE_METHOD: &str = "x.agentmesh360/providers/delete";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateProviderRequest {
    profile: ProviderProfileInput,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateProviderRequest {
    profile_id: String,
    profile: ProviderProfileInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaceProviderSecretRequest {
    profile_id: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteProviderRequest {
    profile_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderListResponse {
    profiles: Vec<ProviderProfileRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProfileResponse {
    profile: ProviderProfileRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProviderResponse {
    deleted: bool,
}

pub struct ProviderService<V> {
    store: ProviderProfileStore,
    vault: V,
}

impl Default for ProviderService<SystemCredentialVault> {
    fn default() -> Self {
        Self {
            store: ProviderProfileStore::default(),
            vault: SystemCredentialVault,
        }
    }
}

impl<V: CredentialVault> ProviderService<V> {
    #[cfg(test)]
    fn new(store: ProviderProfileStore, vault: V) -> Self {
        Self { store, vault }
    }

    fn list(&self, owner_account_id: i64) -> Result<Vec<ProviderProfileRecord>> {
        self.store.list(owner_account_id)
    }

    fn create(
        &self,
        owner_account_id: i64,
        input: ProviderProfileInput,
        api_key: String,
    ) -> Result<ProviderProfileRecord> {
        let input = input.normalized()?;
        let secret = SecretValue::new(api_key)?;
        let credential_ref = CredentialRef::generate();
        let profile_id = format!("pp_{}", Uuid::new_v4().simple());

        self.vault
            .put(&credential_ref, &secret)
            .context("store provider credential")?;
        match self.store.insert(
            owner_account_id,
            &profile_id,
            credential_ref.as_str(),
            &secret.last_four(),
            &input,
        ) {
            Ok(profile) => Ok(profile),
            Err(store_error) => {
                let rollback = self.vault.delete(&credential_ref);
                if rollback.is_err() {
                    return Err(anyhow!(
                        "create provider profile failed and credential cleanup was incomplete"
                    ));
                }
                Err(store_error)
            }
        }
    }

    fn update(
        &self,
        owner_account_id: i64,
        profile_id: &str,
        input: ProviderProfileInput,
    ) -> Result<ProviderProfileRecord> {
        let input = input.normalized()?;
        self.store.update(owner_account_id, profile_id, &input)
    }

    fn replace_secret(
        &self,
        owner_account_id: i64,
        profile_id: &str,
        api_key: String,
    ) -> Result<ProviderProfileRecord> {
        let profile = self.store.get(owner_account_id, profile_id)?;
        let credential_ref = CredentialRef::parse(profile.credential_ref)?;
        let secret = SecretValue::new(api_key)?;
        self.vault
            .put(&credential_ref, &secret)
            .context("replace provider credential")?;
        self.store
            .update_credential_metadata(owner_account_id, profile_id, &secret.last_four())
    }

    fn delete(&self, owner_account_id: i64, profile_id: &str) -> Result<()> {
        let profile = self.store.get(owner_account_id, profile_id)?;
        let credential_ref = CredentialRef::parse(profile.credential_ref)?;
        self.vault
            .delete(&credential_ref)
            .context("delete provider credential")?;
        self.store.delete(owner_account_id, profile_id)
    }
}

pub fn handle(
    service: &ProviderService<SystemCredentialVault>,
    owner_account_id: i64,
    args: &acp::ExtRequest,
) -> crate::extensions::ExtResult {
    let result = match args.method.as_ref() {
        PROVIDERS_LIST_METHOD => service.list(owner_account_id).map(|profiles| {
            serde_json::to_value(ProviderListResponse { profiles })
                .expect("ProviderListResponse is serializable")
        }),
        PROVIDERS_CREATE_METHOD => {
            let request: CreateProviderRequest = crate::extensions::parse_params(args)?;
            service
                .create(owner_account_id, request.profile, request.api_key)
                .and_then(profile_value)
        }
        PROVIDERS_UPDATE_METHOD => {
            let request: UpdateProviderRequest = crate::extensions::parse_params(args)?;
            service
                .update(owner_account_id, &request.profile_id, request.profile)
                .and_then(profile_value)
        }
        PROVIDERS_REPLACE_SECRET_METHOD => {
            let request: ReplaceProviderSecretRequest = crate::extensions::parse_params(args)?;
            service
                .replace_secret(owner_account_id, &request.profile_id, request.api_key)
                .and_then(profile_value)
        }
        PROVIDERS_DELETE_METHOD => {
            let request: DeleteProviderRequest = crate::extensions::parse_params(args)?;
            service
                .delete(owner_account_id, &request.profile_id)
                .and_then(|()| {
                    serde_json::to_value(DeleteProviderResponse { deleted: true })
                        .map_err(Into::into)
                })
        }
        other => Err(anyhow!(
            "unknown AgentMesh360 provider extension method: {other}"
        )),
    };
    crate::extensions::to_ext_response(result)
}

fn profile_value(profile: ProviderProfileRecord) -> Result<serde_json::Value> {
    serde_json::to_value(ProviderProfileResponse { profile }).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentmesh360::credential_vault::{CredentialVaultError, MemoryCredentialVault};
    use crate::agentmesh360::provider_profiles::{ProviderAuthKind, ProviderProtocol};

    fn input(name: &str, base_url: &str) -> ProviderProfileInput {
        ProviderProfileInput {
            preset_id: Some("openai".into()),
            display_name: name.into(),
            protocol: ProviderProtocol::OpenaiResponses,
            base_url: base_url.into(),
            auth_kind: ProviderAuthKind::BearerApiKey,
            enabled_models: vec!["model-main".into()],
        }
    }

    #[test]
    fn provider_lifecycle_keeps_secrets_out_of_profile_storage_and_responses() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = ProviderService::new(
            ProviderProfileStore::in_home(temp.path()),
            MemoryCredentialVault::default(),
        );
        let created = service
            .create(
                41,
                input("Personal OpenAI", "https://api.openai.com/v1"),
                "sk-original-secret-1234".into(),
            )
            .expect("create provider");

        assert_eq!(service.vault.len(), 1);
        assert!(
            service
                .create(
                    41,
                    input("Personal OpenAI", "https://api.openai.com/v1"),
                    "sk-duplicate-secret-9999".into(),
                )
                .is_err()
        );
        assert_eq!(
            service.vault.len(),
            1,
            "failed database inserts must roll back newly written credentials"
        );

        assert_eq!(created.route_revision, 1);
        assert_eq!(created.credential_last_four, "1234");
        let response = serde_json::to_string(&created).expect("serialize response");
        assert!(!response.contains("original-secret"));
        assert!(!response.contains("credential://"));
        let conn = crate::agentmesh360::state::open(temp.path()).expect("open state database");
        let stored_text: String = conn
            .query_row(
                "SELECT profile_id || owner_account_id || COALESCE(preset_id, '') || \
                 display_name || protocol || base_url || auth_kind || credential_ref || \
                 credential_last_four || enabled_models_json FROM provider_profiles",
                [],
                |row| row.get(0),
            )
            .expect("read persisted profile fields");
        assert!(!stored_text.contains("sk-original-secret-1234"));

        let replaced = service
            .replace_secret(41, &created.profile_id, "sk-replaced-5678".into())
            .expect("replace secret");
        assert_eq!(replaced.route_revision, 1);
        assert_eq!(replaced.credential_last_four, "5678");

        let updated = service
            .update(
                41,
                &created.profile_id,
                input("Personal OpenAI", "https://gateway.example.com/v1"),
            )
            .expect("update route");
        assert_eq!(updated.route_revision, 2);

        let credential_ref = CredentialRef::parse(updated.credential_ref.clone()).expect("handle");
        assert_eq!(
            service
                .vault
                .get(&credential_ref)
                .expect("read test secret")
                .expose_for_test(),
            "sk-replaced-5678"
        );

        service
            .delete(41, &created.profile_id)
            .expect("delete provider");
        assert_eq!(service.vault.len(), 0);
        assert!(service.list(41).expect("list profiles").is_empty());
        assert_eq!(
            service
                .vault
                .get(&credential_ref)
                .expect_err("credential deleted"),
            CredentialVaultError::NotFound
        );
    }

    #[test]
    fn provider_operations_are_scoped_to_the_bootstrapped_account() {
        let temp = tempfile::tempdir().expect("tempdir");
        let service = ProviderService::new(
            ProviderProfileStore::in_home(temp.path()),
            MemoryCredentialVault::default(),
        );
        let created = service
            .create(
                41,
                input("OpenAI", "https://api.openai.com/v1"),
                "sk-test-1234".into(),
            )
            .expect("create provider");

        assert!(service.list(42).expect("other account list").is_empty());
        assert!(
            service
                .replace_secret(42, &created.profile_id, "sk-other-9999".into())
                .is_err()
        );
        assert!(service.delete(42, &created.profile_id).is_err());
        assert_eq!(service.list(41).expect("owner list").len(), 1);
    }
}
