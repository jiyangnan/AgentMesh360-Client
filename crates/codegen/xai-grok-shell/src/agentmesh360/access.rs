use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use agent_client_protocol as acp;
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

const DEFAULT_CORE_BASE_URL: &str = "https://api.agentmesh360.com";
const CLIENT_BOOTSTRAP_PATH: &str = "/v1/account/client-bootstrap";
const TRUSTED_TIME_MAX_AGE: Duration = Duration::from_secs(10 * 60);
const TRUSTED_TIME_MAX_WALL_DRIFT: Duration = Duration::from_secs(2 * 60);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct BootstrapAccount {
    pub id: i64,
    pub email: String,
    pub account_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct BootstrapSubscription {
    pub status: String,
    pub source: String,
    pub plan: Option<String>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub auto_renews: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct BootstrapCredits {
    pub balance: i64,
    pub source: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct BootstrapAccess {
    pub can_enter_client: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ClientBootstrapResponse {
    pub schema_version: u32,
    pub server_time: String,
    pub account: BootstrapAccount,
    pub subscription: BootstrapSubscription,
    pub credits: BootstrapCredits,
    pub access: BootstrapAccess,
}

#[derive(Clone, Debug, Default)]
enum AccessState {
    #[default]
    Unverified,
    Granted {
        response: ClientBootstrapResponse,
        valid_until: Instant,
        trusted_time: TrustedServerTime,
    },
    Denied(ClientBootstrapResponse),
}

#[derive(Debug, thiserror::Error)]
pub enum BootstrapError {
    #[error("AgentMesh360 access token is required")]
    MissingToken,
    #[error("AgentMesh360 authentication is required")]
    AuthenticationRequired,
    #[error("AgentMesh360 access verification is temporarily unavailable")]
    VerificationUnavailable,
    #[error("AgentMesh360 Core returned an unsupported bootstrap contract")]
    UnsupportedContract,
}

#[derive(Clone, Debug)]
struct TrustedServerTime {
    server_time: DateTime<Utc>,
    observed_at: Instant,
    observed_wall_time: SystemTime,
    fresh_until: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum TrustedTimeError {
    #[error("AgentMesh360 trusted server time is unavailable")]
    Unavailable,
    #[error("AgentMesh360 trusted server time is stale")]
    Stale,
}

impl TrustedServerTime {
    fn new(
        server_time: DateTime<Utc>,
        observed_at: Instant,
        membership_valid_for: Duration,
    ) -> Result<Self, BootstrapError> {
        Self::new_at(
            server_time,
            observed_at,
            SystemTime::now(),
            membership_valid_for,
        )
    }

    fn new_at(
        server_time: DateTime<Utc>,
        observed_at: Instant,
        observed_wall_time: SystemTime,
        membership_valid_for: Duration,
    ) -> Result<Self, BootstrapError> {
        let fresh_for = TRUSTED_TIME_MAX_AGE.min(membership_valid_for);
        let fresh_until = observed_at
            .checked_add(fresh_for)
            .ok_or(BootstrapError::UnsupportedContract)?;
        Ok(Self {
            server_time,
            observed_at,
            observed_wall_time,
            fresh_until,
        })
    }

    fn current_time_at(
        &self,
        now: Instant,
        wall_time: SystemTime,
    ) -> Result<DateTime<Utc>, TrustedTimeError> {
        if now >= self.fresh_until {
            return Err(TrustedTimeError::Stale);
        }
        let elapsed = now
            .checked_duration_since(self.observed_at)
            .ok_or(TrustedTimeError::Unavailable)?;
        let wall_elapsed = wall_time
            .duration_since(self.observed_wall_time)
            .map_err(|_| TrustedTimeError::Stale)?;
        let wall_drift = wall_elapsed.abs_diff(elapsed);
        if wall_drift > TRUSTED_TIME_MAX_WALL_DRIFT {
            return Err(TrustedTimeError::Stale);
        }
        let elapsed =
            chrono::Duration::from_std(elapsed).map_err(|_| TrustedTimeError::Unavailable)?;
        self.server_time
            .checked_add_signed(elapsed)
            .ok_or(TrustedTimeError::Unavailable)
    }
}

impl BootstrapError {
    pub fn to_acp_error(&self) -> acp::Error {
        let reason = match self {
            Self::MissingToken | Self::AuthenticationRequired => "authentication_required",
            Self::VerificationUnavailable => "access_verification_failed",
            Self::UnsupportedContract => "unsupported_bootstrap_contract",
        };
        acp::Error::auth_required().data(serde_json::json!({
            "code": "agentmesh360_access_required",
            "reason": reason,
            "message": self.to_string(),
        }))
    }
}

#[derive(Debug)]
pub struct ClientAccess {
    client: reqwest::Client,
    core_base_url: String,
    state: Arc<parking_lot::Mutex<AccessState>>,
}

#[derive(Clone)]
pub struct ClientAccessGuard {
    state: Arc<parking_lot::Mutex<AccessState>>,
    owner_account_id: i64,
}

impl std::fmt::Debug for ClientAccessGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClientAccessGuard")
            .field("owner_account_id", &self.owner_account_id)
            .finish_non_exhaustive()
    }
}

impl ClientAccessGuard {
    pub fn require(&self) -> Result<(), acp::Error> {
        require_state(&self.state.lock(), Some(self.owner_account_id))
    }
}

impl Default for ClientAccess {
    fn default() -> Self {
        let core_base_url = std::env::var("AGENTMESH360_CORE_URL")
            .unwrap_or_else(|_| DEFAULT_CORE_BASE_URL.to_owned());
        Self::new(core_base_url)
    }
}

impl ClientAccess {
    pub fn new(core_base_url: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("AgentMesh360 HTTP client configuration is valid");
        Self {
            client,
            core_base_url: core_base_url.into().trim_end_matches('/').to_owned(),
            state: Arc::new(parking_lot::Mutex::new(AccessState::Unverified)),
        }
    }

    #[cfg(test)]
    pub(super) fn with_trusted_time_for_test(server_time: DateTime<Utc>) -> Self {
        Self::with_trusted_time_elapsed_for_test(server_time, Duration::ZERO)
    }

    #[cfg(test)]
    pub(super) fn with_stale_trusted_time_for_test(server_time: DateTime<Utc>) -> Self {
        Self::with_trusted_time_elapsed_for_test(server_time, TRUSTED_TIME_MAX_AGE)
    }

    #[cfg(test)]
    fn with_trusted_time_elapsed_for_test(server_time: DateTime<Utc>, elapsed: Duration) -> Self {
        let access = Self::new("http://127.0.0.1");
        let now = Instant::now();
        let observed_at = now
            .checked_sub(elapsed)
            .expect("test trusted time observation");
        let observed_wall_time = SystemTime::now()
            .checked_sub(elapsed)
            .expect("test trusted wall time observation");
        let trusted_time = TrustedServerTime::new_at(
            server_time,
            observed_at,
            observed_wall_time,
            TRUSTED_TIME_MAX_AGE,
        )
        .expect("test trusted time anchor");
        let valid_until = now
            .checked_add(Duration::from_secs(3600))
            .expect("test access validity");
        *access.state.lock() = AccessState::Granted {
            response: ClientBootstrapResponse {
                schema_version: 1,
                server_time: server_time.to_rfc3339(),
                account: BootstrapAccount {
                    id: 1,
                    email: "trusted-time-test@example.invalid".into(),
                    account_id: 1,
                    display_name: None,
                    avatar_url: None,
                },
                subscription: BootstrapSubscription {
                    status: "active".into(),
                    source: "test".into(),
                    plan: None,
                    period_start: None,
                    period_end: None,
                    auto_renews: false,
                },
                credits: BootstrapCredits {
                    balance: 0,
                    source: "test".into(),
                    expires_at: None,
                },
                access: BootstrapAccess {
                    can_enter_client: true,
                    reason: "test".into(),
                },
            },
            valid_until,
            trusted_time,
        };
        access
    }

    pub async fn bootstrap(
        &self,
        access_token: &str,
    ) -> Result<ClientBootstrapResponse, BootstrapError> {
        *self.state.lock() = AccessState::Unverified;
        if access_token.trim().is_empty() {
            return Err(BootstrapError::MissingToken);
        }

        let response = self
            .client
            .get(format!("{}{}", self.core_base_url, CLIENT_BOOTSTRAP_PATH))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| BootstrapError::VerificationUnavailable)?;

        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(BootstrapError::AuthenticationRequired);
        }
        if !response.status().is_success() {
            return Err(BootstrapError::VerificationUnavailable);
        }

        let bootstrap = response
            .json::<ClientBootstrapResponse>()
            .await
            .map_err(|_| BootstrapError::UnsupportedContract)?;
        if bootstrap.schema_version != 1 {
            return Err(BootstrapError::UnsupportedContract);
        }

        if bootstrap.access.can_enter_client {
            let (server_time, valid_for) = granted_bootstrap_validity(&bootstrap)?;
            let observed_at = Instant::now();
            let valid_until = observed_at
                .checked_add(valid_for)
                .ok_or(BootstrapError::UnsupportedContract)?;
            let trusted_time = TrustedServerTime::new(server_time, observed_at, valid_for)?;
            *self.state.lock() = AccessState::Granted {
                response: bootstrap.clone(),
                valid_until,
                trusted_time,
            };
        } else {
            *self.state.lock() = AccessState::Denied(bootstrap.clone());
        }
        Ok(bootstrap)
    }

    pub fn is_granted(&self) -> bool {
        self.require().is_ok()
    }

    pub fn invalidate(&self) {
        *self.state.lock() = AccessState::Unverified;
    }

    pub fn remaining_validity(&self) -> Option<Duration> {
        match &*self.state.lock() {
            AccessState::Granted { valid_until, .. } => {
                valid_until.checked_duration_since(Instant::now())
            }
            AccessState::Denied(_) | AccessState::Unverified => None,
        }
    }

    pub fn current_account_id(&self) -> Option<i64> {
        match &*self.state.lock() {
            AccessState::Granted {
                response,
                valid_until,
                ..
            } if Instant::now() < *valid_until => Some(response.account.account_id),
            AccessState::Granted { .. } | AccessState::Denied(_) | AccessState::Unverified => None,
        }
    }

    pub fn require(&self) -> Result<(), acp::Error> {
        require_state(&self.state.lock(), None)
    }

    pub(super) fn trusted_server_now(&self) -> Result<DateTime<Utc>, TrustedTimeError> {
        let now = Instant::now();
        match &*self.state.lock() {
            AccessState::Granted {
                valid_until,
                trusted_time,
                ..
            } if now < *valid_until => trusted_time.current_time_at(now, SystemTime::now()),
            AccessState::Granted { .. } | AccessState::Denied(_) | AccessState::Unverified => {
                Err(TrustedTimeError::Unavailable)
            }
        }
    }

    pub fn guard(&self, owner_account_id: i64) -> ClientAccessGuard {
        ClientAccessGuard {
            state: Arc::clone(&self.state),
            owner_account_id,
        }
    }
}

fn require_state(state: &AccessState, expected_account_id: Option<i64>) -> Result<(), acp::Error> {
    match state {
        AccessState::Granted {
            response,
            valid_until,
            ..
        } if Instant::now() < *valid_until
            && expected_account_id
                .is_none_or(|expected| expected == response.account.account_id) =>
        {
            debug_assert!(response.access.can_enter_client);
            Ok(())
        }
        AccessState::Granted {
            response,
            valid_until,
            ..
        } if Instant::now() < *valid_until => {
            Err(acp::Error::auth_required().data(serde_json::json!({
                "code": "agentmesh360_access_required",
                "reason": "account_changed",
                "accountId": response.account.account_id,
            })))
        }
        AccessState::Granted { response, .. } => {
            Err(acp::Error::auth_required().data(serde_json::json!({
                "code": "agentmesh360_subscription_required",
                "reason": "subscription_expired",
                "subscriptionStatus": response.subscription.status,
            })))
        }
        AccessState::Denied(response) => Err(acp::Error::auth_required().data(serde_json::json!({
            "code": "agentmesh360_subscription_required",
            "reason": response.access.reason,
            "subscriptionStatus": response.subscription.status,
        }))),
        AccessState::Unverified => Err(acp::Error::auth_required().data(serde_json::json!({
            "code": "agentmesh360_access_required",
            "reason": "access_unverified",
        }))),
    }
}

fn granted_bootstrap_validity(
    response: &ClientBootstrapResponse,
) -> Result<(DateTime<Utc>, Duration), BootstrapError> {
    let server_time = DateTime::parse_from_rfc3339(&response.server_time)
        .map_err(|_| BootstrapError::UnsupportedContract)?
        .with_timezone(&Utc);
    let period_end = response
        .subscription
        .period_end
        .as_deref()
        .ok_or(BootstrapError::UnsupportedContract)
        .and_then(|value| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .map(|value| value.and_utc())
                .map_err(|_| BootstrapError::UnsupportedContract)
        })?;
    let valid_for = (period_end - server_time)
        .to_std()
        .map_err(|_| BootstrapError::UnsupportedContract)
        .and_then(|duration| {
            if duration.is_zero() {
                Err(BootstrapError::UnsupportedContract)
            } else {
                Ok(duration)
            }
        })?;
    Ok((server_time, valid_for))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const ACTIVE_BODY: &str = r#"{
        "schema_version":1,
        "server_time":"2026-07-22T00:00:00Z",
        "account":{"id":1,"email":"u@example.com","account_id":1,"display_name":null,"avatar_url":null},
        "subscription":{"status":"active","source":"monthly_pass","plan":"monthly_pass","period_start":"2026-07-01 00:00:00","period_end":"2026-07-31 00:00:00","auto_renews":false},
        "credits":{"balance":0,"source":"monthly_pass","expires_at":"2026-07-31 00:00:00"},
        "access":{"can_enter_client":true,"reason":"active_subscription"}
    }"#;

    async fn serve_once(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let status = status.to_owned();
        let body = body.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = vec![0; 4096];
            let read = stream.read(&mut request).await.expect("read");
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.expect("write");
            request
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn active_bootstrap_grants_access_without_persisting_the_token() {
        let (base_url, server) = serve_once("200 OK", ACTIVE_BODY).await;
        let access = ClientAccess::new(base_url);

        let response = access.bootstrap("secret-jwt").await.expect("bootstrap");

        assert!(response.access.can_enter_client);
        assert_eq!(response.credits.balance, 0);
        let client_wire = serde_json::to_value(&response).expect("client response");
        assert_eq!(client_wire["schemaVersion"], 1);
        assert_eq!(client_wire["access"]["canEnterClient"], true);
        assert!(client_wire.get("schema_version").is_none());
        assert!(access.is_granted());
        assert_eq!(access.current_account_id(), Some(1));
        let trusted_time = access
            .trusted_server_now()
            .expect("fresh trusted server time");
        let bootstrap_time = DateTime::parse_from_rfc3339("2026-07-22T00:00:00Z")
            .expect("bootstrap time")
            .with_timezone(&Utc);
        assert!(trusted_time >= bootstrap_time);
        assert!(trusted_time < bootstrap_time + chrono::Duration::seconds(5));
        access.require().expect("granted");
        let guard = access.guard(1);
        guard.require().expect("matching live account guard");
        assert!(access.guard(2).require().is_err());
        access.invalidate();
        assert!(!access.is_granted());
        assert!(matches!(
            access.trusted_server_now(),
            Err(TrustedTimeError::Unavailable)
        ));
        assert!(guard.require().is_err());
        assert_eq!(access.current_account_id(), None);
        let request = server.await.expect("server");
        assert!(request.starts_with("GET /v1/account/client-bootstrap HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer secret-jwt")
        );
        assert!(!format!("{access:?}").contains("secret-jwt"));
    }

    #[tokio::test]
    async fn denied_bootstrap_returns_paywall_state_and_blocks_agent_access() {
        let denied = ACTIVE_BODY
            .replace("\"status\":\"active\"", "\"status\":\"expired\"")
            .replace("\"can_enter_client\":true", "\"can_enter_client\":false")
            .replace("active_subscription", "subscription_expired");
        let (base_url, server) = serve_once("200 OK", &denied).await;
        let access = ClientAccess::new(base_url);

        let response = access.bootstrap("expired-jwt").await.expect("bootstrap");

        assert!(!response.access.can_enter_client);
        assert!(!access.is_granted());
        assert!(matches!(
            access.trusted_server_now(),
            Err(TrustedTimeError::Unavailable)
        ));
        assert_eq!(access.current_account_id(), None);
        let error = access.require().expect_err("denied");
        assert_eq!(error.code, acp::Error::auth_required().code);
        let _ = server.await.expect("server");
    }

    #[tokio::test]
    async fn authentication_and_contract_failures_are_fail_closed() {
        let (base_url, unauthorized) = serve_once("401 Unauthorized", "{}").await;
        let access = ClientAccess::new(base_url);
        assert!(matches!(
            access.bootstrap("bad-jwt").await,
            Err(BootstrapError::AuthenticationRequired)
        ));
        assert!(!access.is_granted());
        assert!(access.require().is_err());
        let _ = unauthorized.await.expect("server");

        let invalid = ACTIVE_BODY.replace("\"schema_version\":1", "\"schema_version\":2");
        let (base_url, unsupported) = serve_once("200 OK", &invalid).await;
        let access = ClientAccess::new(base_url);
        assert!(matches!(
            access.bootstrap("fresh-jwt").await,
            Err(BootstrapError::UnsupportedContract)
        ));
        assert!(!access.is_granted());
        let _ = unsupported.await.expect("server");

        let elapsed = ACTIVE_BODY.replace(
            "\"period_end\":\"2026-07-31 00:00:00\"",
            "\"period_end\":\"2026-06-30 00:00:00\"",
        );
        let (base_url, elapsed_server) = serve_once("200 OK", &elapsed).await;
        let access = ClientAccess::new(base_url);
        assert!(matches!(
            access.bootstrap("fresh-jwt").await,
            Err(BootstrapError::UnsupportedContract)
        ));
        assert!(!access.is_granted());
        let _ = elapsed_server.await.expect("server");

        let invalid_time = ACTIVE_BODY.replace(
            "\"server_time\":\"2026-07-22T00:00:00Z\"",
            "\"server_time\":\"not-a-time\"",
        );
        let (base_url, invalid_time_server) = serve_once("200 OK", &invalid_time).await;
        let access = ClientAccess::new(base_url);
        assert!(matches!(
            access.bootstrap("fresh-jwt").await,
            Err(BootstrapError::UnsupportedContract)
        ));
        assert!(matches!(
            access.trusted_server_now(),
            Err(TrustedTimeError::Unavailable)
        ));
        let _ = invalid_time_server.await.expect("server");
    }

    #[test]
    fn trusted_server_time_uses_monotonic_elapsed_time_and_expires_fail_closed() {
        let server_time = DateTime::parse_from_rfc3339("2026-07-22T00:00:00Z")
            .expect("server time")
            .with_timezone(&Utc);
        let observed_at = Instant::now();
        let observed_wall_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000_000);
        let anchor = TrustedServerTime::new_at(
            server_time,
            observed_at,
            observed_wall_time,
            Duration::from_secs(3600),
        )
        .expect("trusted time anchor");

        assert_eq!(
            anchor
                .current_time_at(
                    observed_at + Duration::from_secs(90),
                    observed_wall_time + Duration::from_secs(90)
                )
                .expect("fresh time"),
            server_time + chrono::Duration::seconds(90)
        );
        assert_eq!(
            anchor.current_time_at(
                observed_at + TRUSTED_TIME_MAX_AGE,
                observed_wall_time + TRUSTED_TIME_MAX_AGE
            ),
            Err(TrustedTimeError::Stale)
        );
        assert_eq!(
            anchor.current_time_at(
                observed_at
                    .checked_sub(Duration::from_secs(1))
                    .expect("earlier instant"),
                observed_wall_time
            ),
            Err(TrustedTimeError::Unavailable)
        );
        assert_eq!(
            anchor.current_time_at(
                observed_at + Duration::from_secs(60),
                observed_wall_time
                    .checked_sub(Duration::from_secs(1))
                    .expect("rolled-back wall time")
            ),
            Err(TrustedTimeError::Stale)
        );
        assert_eq!(
            anchor.current_time_at(
                observed_at + Duration::from_secs(60),
                observed_wall_time + Duration::from_secs(5 * 60)
            ),
            Err(TrustedTimeError::Stale)
        );

        let short_membership = TrustedServerTime::new_at(
            server_time,
            observed_at,
            observed_wall_time,
            Duration::from_secs(30),
        )
        .expect("short trusted time anchor");
        assert!(
            short_membership
                .current_time_at(
                    observed_at + Duration::from_secs(29),
                    observed_wall_time + Duration::from_secs(29)
                )
                .is_ok()
        );
        assert_eq!(
            short_membership.current_time_at(
                observed_at + Duration::from_secs(30),
                observed_wall_time + Duration::from_secs(30)
            ),
            Err(TrustedTimeError::Stale)
        );
    }
}
