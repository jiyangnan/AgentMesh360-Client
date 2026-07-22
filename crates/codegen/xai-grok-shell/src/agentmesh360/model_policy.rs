use serde::{Deserialize, Serialize};

use super::provider_catalog::{CapabilityStatus, ModelCapability};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRequirement {
    Required,
    Preferred,
    #[default]
    Optional,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelPolicy {
    #[serde(default)]
    pub tools: CapabilityRequirement,
    #[serde(default)]
    pub parallel_tool_calls: CapabilityRequirement,
    #[serde(default)]
    pub vision: CapabilityRequirement,
    #[serde(default)]
    pub structured_output: CapabilityRequirement,
    #[serde(default)]
    pub reasoning: CapabilityRequirement,
    #[serde(default)]
    pub streaming: CapabilityRequirement,
    pub min_context_window: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyEvaluation {
    pub blockers: Vec<String>,
    pub unmet_preferences: Vec<String>,
}

impl PolicyEvaluation {
    pub fn is_compatible(&self) -> bool {
        self.blockers.is_empty()
    }
}

impl AgentModelPolicy {
    pub fn evaluate(&self, capability: &ModelCapability) -> PolicyEvaluation {
        let mut evaluation = PolicyEvaluation {
            blockers: Vec::new(),
            unmet_preferences: Vec::new(),
        };
        evaluate_requirement("tools", self.tools, capability.tools, &mut evaluation);
        evaluate_requirement(
            "parallel_tool_calls",
            self.parallel_tool_calls,
            capability.parallel_tool_calls,
            &mut evaluation,
        );
        evaluate_requirement("vision", self.vision, capability.vision, &mut evaluation);
        evaluate_requirement(
            "structured_output",
            self.structured_output,
            capability.structured_output,
            &mut evaluation,
        );
        evaluate_requirement(
            "reasoning",
            self.reasoning,
            capability.reasoning,
            &mut evaluation,
        );
        evaluate_requirement(
            "streaming",
            self.streaming,
            capability.streaming,
            &mut evaluation,
        );

        if let Some(required) = self.min_context_window {
            match capability.context_window {
                Some(actual) if actual >= required => {}
                Some(actual) => evaluation.blockers.push(format!(
                    "context_window requires at least {required} tokens but model declares {actual}"
                )),
                None => evaluation.blockers.push(format!(
                    "context_window requires at least {required} tokens but capability is unknown"
                )),
            }
        }
        evaluation
    }
}

fn evaluate_requirement(
    name: &str,
    requirement: CapabilityRequirement,
    status: CapabilityStatus,
    evaluation: &mut PolicyEvaluation,
) {
    if status == CapabilityStatus::Supported {
        return;
    }
    let detail = format!("{name} is {status:?}").to_lowercase();
    match requirement {
        CapabilityRequirement::Required => evaluation.blockers.push(detail),
        CapabilityRequirement::Preferred => evaluation.unmet_preferences.push(detail),
        CapabilityRequirement::Optional => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capable() -> ModelCapability {
        ModelCapability {
            context_window: Some(128_000),
            max_output_tokens: Some(8192),
            tools: CapabilityStatus::Supported,
            parallel_tool_calls: CapabilityStatus::Unknown,
            vision: CapabilityStatus::Unsupported,
            structured_output: CapabilityStatus::Supported,
            reasoning: CapabilityStatus::Unknown,
            streaming: CapabilityStatus::Supported,
            source: super::super::provider_catalog::CapabilitySource::Catalog,
        }
    }

    #[test]
    fn required_unknown_or_unsupported_capabilities_fail_closed() {
        let policy = AgentModelPolicy {
            tools: CapabilityRequirement::Required,
            vision: CapabilityRequirement::Required,
            reasoning: CapabilityRequirement::Required,
            min_context_window: Some(200_000),
            ..AgentModelPolicy::default()
        };

        let result = policy.evaluate(&capable());

        assert!(!result.is_compatible());
        assert_eq!(result.blockers.len(), 3);
    }

    #[test]
    fn preferred_capabilities_warn_without_blocking() {
        let policy = AgentModelPolicy {
            parallel_tool_calls: CapabilityRequirement::Preferred,
            reasoning: CapabilityRequirement::Preferred,
            min_context_window: Some(64_000),
            ..AgentModelPolicy::default()
        };

        let result = policy.evaluate(&capable());

        assert!(result.is_compatible());
        assert_eq!(result.unmet_preferences.len(), 2);
    }
}
