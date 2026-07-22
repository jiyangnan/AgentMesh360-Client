use indexmap::IndexMap;

/// Configuration for the web search tool.
///
/// Use `Disabled` when no API key is available or web search should be turned off.
/// Use `Enabled { … }` to provide credentials and endpoint configuration.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WebSearchConfig {
    #[default]
    Disabled,
    Enabled {
        api_key: String,
        base_url: String,
        model: String,
        #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
        extra_headers: IndexMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        alpha_test_key: Option<String>,
    },
}

fn redacted_endpoint(raw: &str) -> String {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return if raw.trim().is_empty() {
            String::new()
        } else {
            "<configured>".to_owned()
        };
    };
    let Some(host) = url.host_str() else {
        return "<configured>".to_owned();
    };
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

impl std::fmt::Debug for WebSearchConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => f.write_str("WebSearchConfig::Disabled"),
            Self::Enabled {
                api_key,
                base_url,
                model,
                extra_headers,
                alpha_test_key,
            } => f
                .debug_struct("WebSearchConfig::Enabled")
                .field("credential_present", &!api_key.trim().is_empty())
                .field("endpoint_configured", &!base_url.trim().is_empty())
                .field("model", model)
                .field("extra_header_count", &extra_headers.len())
                .field("alpha_test_credential_present", &alpha_test_key.is_some())
                .finish(),
        }
    }
}

impl WebSearchConfig {
    /// Returns `true` when the config is the `Enabled` variant.
    pub fn is_enabled(&self) -> bool {
        matches!(self, Self::Enabled { .. })
    }

    /// Return a copy safe for returning to clients.
    ///
    /// The `api_key` is replaced with `"***REDACTED***"` and the optional
    /// extra access key field is stripped.
    pub fn redacted(&self) -> Self {
        match self {
            Self::Disabled => Self::Disabled,
            Self::Enabled {
                base_url,
                model,
                extra_headers,
                ..
            } => Self::Enabled {
                api_key: "***REDACTED***".to_string(),
                base_url: redacted_endpoint(base_url),
                model: model.clone(),
                extra_headers: extra_headers
                    .keys()
                    .map(|name| (name.clone(), "***REDACTED***".to_owned()))
                    .collect(),
                alpha_test_key: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default_is_disabled() {
        let config = WebSearchConfig::default();
        assert!(!config.is_enabled());
    }

    #[test]
    fn test_config_enabled() {
        let config = WebSearchConfig::Enabled {
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-web-search-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        assert!(config.is_enabled());
    }

    #[test]
    fn test_config_redacted() {
        let mut headers = IndexMap::new();
        headers.insert("X-Custom".to_string(), "value".to_string());
        let config = WebSearchConfig::Enabled {
            api_key: "secret-key-12345".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-web-search-model".to_string(),
            extra_headers: headers,
            alpha_test_key: Some("alpha-secret".to_string()),
        };
        let redacted = config.redacted();
        match redacted {
            WebSearchConfig::Enabled {
                api_key,
                base_url,
                model,
                extra_headers,
                alpha_test_key,
            } => {
                assert_eq!(api_key, "***REDACTED***");
                assert_eq!(base_url, "https://api.x.ai");
                assert_eq!(model, "test-web-search-model");
                assert_eq!(extra_headers.get("X-Custom").unwrap(), "***REDACTED***");
                assert!(alpha_test_key.is_none());
            }
            _ => panic!("Expected Enabled variant"),
        }
    }

    #[test]
    fn config_debug_and_redacted_copy_never_render_credential_material() {
        let sentinel = "AM360_WEB_SEARCH_SENTINEL_4c8a1e09d75fb263";
        let config = WebSearchConfig::Enabled {
            api_key: sentinel.into(),
            base_url: format!("https://{sentinel}@search.example/v1/{sentinel}?k={sentinel}"),
            model: "safe-model".into(),
            extra_headers: IndexMap::from([("X-Custom".into(), sentinel.into())]),
            alpha_test_key: Some(sentinel.into()),
        };
        let rendered = format!("{config:?} {:?}", config.redacted());
        for forbidden in [
            sentinel,
            "AM360_WEB_SEARCH_SENTINEL",
            "4c8a1e09",
            "d75fb263",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "WebSearchConfig leaked credential material: {rendered}"
            );
        }
        assert!(rendered.contains("credential_present: true"));
    }

    #[test]
    fn test_config_serde_roundtrip() {
        let config = WebSearchConfig::Enabled {
            api_key: "key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-web-search-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WebSearchConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_enabled());
    }

    #[test]
    fn test_config_deserialize_from_set_options_payload() {
        let json = r#"{
            "status": "enabled",
            "api_key": "xai-abc123",
            "base_url": "https://api.x.ai/v1",
            "model": "test-web-search-model"
        }"#;
        let config: WebSearchConfig = serde_json::from_str(json).unwrap();
        assert!(config.is_enabled());
    }
}
