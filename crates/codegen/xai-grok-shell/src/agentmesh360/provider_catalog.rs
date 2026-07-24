use std::collections::HashSet;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use url::Url;

use super::provider_profiles::normalize_model_id;
use super::provider_profiles::{ProviderAuthKind, ProviderProtocol, normalize_base_url};

const CATALOG_SCHEMA_VERSION: u32 = 1;
const BUILTIN_CATALOG: &str = include_str!("provider_catalog.v1.json");

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderClassification {
    Official,
    Aggregator,
    Gateway,
    Custom,
    Local,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderQuirk {
    #[serde(rename = "anthropic_version_2023_06_01")]
    AnthropicVersion2023_06_01,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilitySource {
    Catalog,
    ProviderReported,
    ProbeVerified,
    UserOverride,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapability {
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub tools: CapabilityStatus,
    pub parallel_tool_calls: CapabilityStatus,
    pub vision: CapabilityStatus,
    pub structured_output: CapabilityStatus,
    pub reasoning: CapabilityStatus,
    pub streaming: CapabilityStatus,
    pub source: CapabilitySource,
}

impl ModelCapability {
    pub fn unknown() -> Self {
        Self {
            context_window: None,
            max_output_tokens: None,
            tools: CapabilityStatus::Unknown,
            parallel_tool_calls: CapabilityStatus::Unknown,
            vision: CapabilityStatus::Unknown,
            structured_output: CapabilityStatus::Unknown,
            reasoning: CapabilityStatus::Unknown,
            streaming: CapabilityStatus::Unknown,
            source: CapabilitySource::Catalog,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogModel {
    pub model_id: String,
    pub display_name: String,
    pub capability: ModelCapability,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPreset {
    pub preset_id: String,
    pub display_name: String,
    pub classification: ProviderClassification,
    pub protocol: ProviderProtocol,
    pub default_base_url: Option<String>,
    pub auth_kind: ProviderAuthKind,
    #[serde(default)]
    pub allowed_endpoint_origins: Vec<String>,
    #[serde(default)]
    pub quirks: Vec<ProviderQuirk>,
    #[serde(default)]
    pub models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCatalog {
    pub schema_version: u32,
    pub catalog_revision: u64,
    pub providers: Vec<ProviderPreset>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogLoadStatus {
    TrustedDocument,
    BuiltinFallback,
}

impl ProviderCatalog {
    pub fn builtin() -> Self {
        Self::parse_and_validate(BUILTIN_CATALOG).expect("built-in Provider Catalog must be valid")
    }

    pub fn from_trusted_document_or_builtin(document: &str) -> (Self, CatalogLoadStatus) {
        match Self::parse_and_validate(document) {
            Ok(catalog) => (catalog, CatalogLoadStatus::TrustedDocument),
            Err(_) => (Self::builtin(), CatalogLoadStatus::BuiltinFallback),
        }
    }

    pub fn provider(&self, preset_id: &str) -> Option<&ProviderPreset> {
        self.providers
            .iter()
            .find(|provider| provider.preset_id == preset_id)
    }

    pub fn model(&self, preset_id: &str, model_id: &str) -> Option<&CatalogModel> {
        self.provider(preset_id)?
            .models
            .iter()
            .find(|model| model.model_id == model_id)
    }

    fn parse_and_validate(document: &str) -> Result<Self> {
        let mut catalog: Self = serde_json::from_str(document)?;
        catalog.validate_and_normalize()?;
        Ok(catalog)
    }

    fn validate_and_normalize(&mut self) -> Result<()> {
        if self.schema_version != CATALOG_SCHEMA_VERSION {
            bail!("unsupported Provider Catalog schema version");
        }
        if self.catalog_revision == 0 {
            bail!("Provider Catalog revision must be positive");
        }
        if self.providers.is_empty() || self.providers.len() > 128 {
            bail!("Provider Catalog must contain 1 to 128 providers");
        }

        let mut preset_ids = HashSet::new();
        for provider in &mut self.providers {
            validate_identifier(&provider.preset_id, "Provider preset id")?;
            validate_display_name(&provider.display_name, "Provider display name")?;
            if !preset_ids.insert(provider.preset_id.clone()) {
                bail!("Provider Catalog contains duplicate preset ids");
            }

            if let Some(base_url) = &provider.default_base_url {
                provider.default_base_url = Some(normalize_base_url(base_url)?);
            }

            let mut origins = HashSet::new();
            for origin in &mut provider.allowed_endpoint_origins {
                *origin = normalize_origin(origin)?;
                if !origins.insert(origin.clone()) {
                    bail!("Provider Catalog contains duplicate endpoint origins");
                }
            }
            if provider.classification == ProviderClassification::Official {
                let Some(default_base_url) = provider.default_base_url.as_deref() else {
                    bail!("official Provider presets require a default base URL");
                };
                let default_origin = origin_from_base_url(default_base_url)?;
                if !origins.contains(&default_origin) {
                    bail!("official Provider default endpoint must be explicitly allowlisted");
                }
            }

            let mut quirks = HashSet::new();
            if !provider.quirks.iter().all(|quirk| quirks.insert(*quirk)) {
                bail!("Provider Catalog contains duplicate quirks");
            }

            let mut model_ids = HashSet::new();
            for model in &mut provider.models {
                model.model_id = normalize_model_id(&model.model_id)?;
                validate_display_name(&model.display_name, "model display name")?;
                if !model_ids.insert(model.model_id.clone()) {
                    bail!("Provider Catalog contains duplicate model ids");
                }
                if model.capability.context_window == Some(0)
                    || model.capability.max_output_tokens == Some(0)
                {
                    bail!("model token limits must be positive");
                }
                if model.capability.source != CapabilitySource::Catalog {
                    bail!("built-in Provider Catalog cannot claim runtime capability evidence");
                }
            }
        }
        Ok(())
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn validate_display_name(value: &str, label: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn normalize_origin(value: &str) -> Result<String> {
    let normalized = normalize_base_url(value)?;
    let url = Url::parse(&normalized)?;
    if url.path() != "/" {
        bail!("Provider Catalog endpoint origins must not contain a path");
    }
    Ok(url.origin().ascii_serialization())
}

fn origin_from_base_url(value: &str) -> Result<String> {
    let normalized = normalize_base_url(value)?;
    let url = Url::parse(&normalized)?;
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRUSTED_CATALOG: &str = r#"{
      "schemaVersion": 1,
      "catalogRevision": 7,
      "providers": [{
        "presetId": "test-provider",
        "displayName": "Test Provider",
        "classification": "official",
        "protocol": "openai_responses",
        "defaultBaseUrl": "https://example.com/v1/",
        "authKind": "bearer_api_key",
        "allowedEndpointOrigins": ["https://example.com"],
        "quirks": [],
        "models": [{
          "modelId": "test-model",
          "displayName": "Test Model",
          "capability": {
            "contextWindow": 128000,
            "maxOutputTokens": 8192,
            "tools": "supported",
            "parallelToolCalls": "unknown",
            "vision": "unsupported",
            "structuredOutput": "supported",
            "reasoning": "unknown",
            "streaming": "supported",
            "source": "catalog"
          }
        }]
      }]
    }"#;

    #[test]
    fn built_in_catalog_is_valid_and_declarative() {
        let catalog = ProviderCatalog::builtin();

        assert_eq!(catalog.schema_version, 1);
        assert!(catalog.provider("openai").is_some());
        assert!(catalog.provider("xai").is_some());
        assert!(catalog.provider("anthropic").is_some());
        assert!(
            !catalog.providers.iter().any(|provider| {
                provider
                    .default_base_url
                    .as_deref()
                    .is_some_and(|url| url.contains("generativelanguage.googleapis.com"))
            }),
            "Gemini must stay out of the built-in Catalog until the live contract and thought-state round trip pass"
        );
        assert_eq!(
            catalog.provider("anthropic").expect("anthropic").quirks,
            [ProviderQuirk::AnthropicVersion2023_06_01]
        );
    }

    #[test]
    fn trusted_catalog_exposes_model_capabilities() {
        let (catalog, status) = ProviderCatalog::from_trusted_document_or_builtin(TRUSTED_CATALOG);

        assert_eq!(status, CatalogLoadStatus::TrustedDocument);
        let model = catalog
            .model("test-provider", "test-model")
            .expect("catalog model");
        assert_eq!(model.capability.tools, CapabilityStatus::Supported);
        assert_eq!(model.capability.context_window, Some(128_000));
        assert_eq!(
            catalog
                .provider("test-provider")
                .and_then(|provider| provider.default_base_url.as_deref()),
            Some("https://example.com/v1")
        );
    }

    #[test]
    fn invalid_or_future_catalog_falls_back_to_builtin() {
        for invalid in [
            r#"{"schemaVersion":2,"catalogRevision":1,"providers":[]}"#,
            &TRUSTED_CATALOG.replace("\"quirks\": []", "\"quirks\": [\"run_script\"]"),
            &TRUSTED_CATALOG.replace("\"source\": \"catalog\"", "\"source\": \"probe_verified\""),
        ] {
            let (catalog, status) = ProviderCatalog::from_trusted_document_or_builtin(invalid);
            assert_eq!(status, CatalogLoadStatus::BuiltinFallback);
            assert!(catalog.provider("openai").is_some());
        }
    }

    #[test]
    fn unknown_capability_is_conservative() {
        let capability = ModelCapability::unknown();
        assert_eq!(capability.tools, CapabilityStatus::Unknown);
        assert_eq!(capability.context_window, None);
    }
}
